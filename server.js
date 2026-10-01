const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');
require('dotenv').config();

const MODEL = 'claude-haiku-4-5';
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();

// Render sits behind one proxy hop; without this every visitor shares the proxy's IP
// and the rate limiter would throttle everyone together.
app.set('trust proxy', 1);

// The frontend is served by this same app, so browsers don't need CORS at all.
// This only stops *other* websites from calling the API from a visitor's browser.
const allowedOrigins = ['https://form-ai-workout.onrender.com'];
if (!IS_PROD) allowedOrigins.push('http://localhost:3000');
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: '10kb' }));
app.use(express.static('.'));

// ─── ERRORS ───
// Every API error has the shape { error: { code, message, retryable } }.
class ApiError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function sendError(res, err) {
  res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
}

// ─── RATE LIMITING ───
function makeLimiter(limit, what) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime;
      const minutes = resetTime ? Math.max(1, Math.ceil((resetTime - Date.now()) / 60000)) : 15;
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: `You've hit the limit of ${limit} ${what} per 15 minutes. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          retryable: false,
          retryAfterMinutes: minutes,
        },
      });
    },
  });
}

const generateLimiter = makeLimiter(10, 'plans');
const swapLimiter = makeLimiter(30, 'swaps');

// ─── INPUT SCHEMAS ───
const GENDERS = ['male', 'female', 'non-binary'];
const UNITS = ['lbs', 'kg'];
const GOALS = ['toning', 'strength', 'bulking', 'cutting', 'endurance', 'general fitness'];
const EXPERIENCE = ['beginner', 'intermediate', 'advanced'];
const EQUIPMENT = ['full gym', 'dumbbells only', 'home gym', 'bodyweight only', 'bands and cables'];

const shortText = (max) => z.string().trim().min(1).max(max);

const GenerateInput = z.object({
  age: z.coerce.number().int().min(13).max(100),
  weight: z.coerce.number().min(30).max(1000),
  unit: z.enum(UNITS),
  gender: z.enum(GENDERS),
  days: z.coerce.number().int().min(2).max(6),
  goal: z.enum(GOALS),
  experience: z.enum(EXPERIENCE),
  equipment: z.enum(EQUIPMENT),
});

const SwapInput = z.object({
  exercise: z.object({
    name: shortText(100),
    sets: shortText(40),
    rest: z.string().trim().max(40).optional().default(''),
    muscle_group: z.string().trim().max(60).optional().default(''),
  }),
  dayFocus: shortText(100),
  avoid: z.array(shortText(100)).max(12).default([]),
  goal: z.enum(GOALS),
  experience: z.enum(EXPERIENCE),
  equipment: z.enum(EQUIPMENT),
});

// ─── OUTPUT SCHEMAS ───
// Structured outputs guarantee the *shape* (fields, types, required keys), but not numeric or
// length limits like "10–180 minutes" or "exactly 4 days" — the SDK only passes those along as hints.
// So: the day count is built into the shape (day_1 … day_N keys), and limits are applied
// afterwards in normalizePlan / normalizeExercise instead of rejecting the whole response.
const ExerciseSchema = z.object({
  name: z.string(),
  muscle_group: z.string(),
  sets: z.string(),
  rest: z.string(),
  note: z.string(),
});

const DaySchema = z.object({
  focus: z.string(),
  type: z.string(),
  duration_minutes: z.number().int(),
  exercises: z.array(ExerciseSchema),
});

const planSchemas = new Map();
function planSchemaFor(days) {
  if (!planSchemas.has(days)) {
    const shape = {};
    for (let i = 1; i <= days; i++) shape[`day_${i}`] = DaySchema;
    shape.nutrition = z.string();
    planSchemas.set(days, z.object(shape));
  }
  return planSchemas.get(days);
}

const MIN_EXERCISES = 3;
const MAX_EXERCISES = 9;

function invalidOutput(reason) {
  console.error('AI output rejected:', reason);
  return new ApiError(502, 'ai_invalid_response', 'The AI sent back an incomplete plan. Please try again.', true);
}

// Returns a cleaned exercise, or null if it's missing something essential.
function normalizeExercise(ex) {
  const clean = {
    name: ex.name.trim(),
    muscle_group: ex.muscle_group.trim(),
    sets: ex.sets.trim(),
    rest: ex.rest.trim(),
    note: ex.note.trim(),
  };
  return clean.name && clean.sets ? clean : null;
}

function normalizePlan(raw, days) {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = raw[`day_${i}`];
    const exercises = d.exercises.map(normalizeExercise).filter(Boolean).slice(0, MAX_EXERCISES);
    if (exercises.length < MIN_EXERCISES) throw invalidOutput(`day_${i} has only ${exercises.length} usable exercises`);
    out.push({
      day: `Day ${i}`,
      focus: d.focus.trim() || d.type.trim() || 'Workout',
      type: d.type.trim(),
      duration_minutes: Math.min(180, Math.max(10, Math.round(d.duration_minutes))),
      exercises,
    });
  }
  return { days: out, nutrition: raw.nutrition.trim() };
}

// ─── CLAUDE CALL ───
let client;
function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY environment variable');
    throw new ApiError(500, 'server_misconfigured', 'The server is missing its API key. Please let the site owner know.', false);
  }
  client ??= new Anthropic({ apiKey, timeout: 60 * 1000, maxRetries: 2 });
  return client;
}

// Asks for JSON matching `schema`, then runs `normalize` on it. If the output is unusable,
// asks once more before giving up (network/overload retries are handled by the SDK itself).
async function askForJson(prompt, schema, maxTokens, normalize) {
  try {
    return normalize(await requestJson(prompt, schema, maxTokens));
  } catch (err) {
    if (err?.code !== 'ai_invalid_response') throw err;
    console.warn('Retrying once after unusable AI output');
    return normalize(await requestJson(prompt, schema, maxTokens));
  }
}

// Non-streaming call: the full response arrives at once, so it's validated as a whole.
async function requestJson(prompt, schema, maxTokens) {
  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: zodOutputFormat(schema) },
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('Anthropic API error:', err.status ?? '', err.message);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ApiError(500, 'server_misconfigured', 'The server\'s API key isn\'t working. Please let the site owner know.', false);
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new ApiError(504, 'ai_timeout', 'The AI took too long to answer. Please try again.', true);
    }
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      throw new ApiError(503, 'ai_unavailable', 'The AI service is busy right now. Give it a moment and try again.', true);
    }
    throw new ApiError(502, 'ai_error', 'Something went wrong talking to the AI service.', true);
  }

  if (response.stop_reason === 'max_tokens') {
    console.error('Response truncated at max_tokens:', response.usage);
    throw new ApiError(502, 'ai_truncated', 'The AI response was cut off before it finished. Please try again.', true);
  }
  if (response.stop_reason === 'refusal') {
    throw new ApiError(502, 'ai_refused', "The AI couldn't complete this request. Try adjusting your selections.", true);
  }

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('AI returned non-JSON output:', text.slice(0, 500));
    throw new ApiError(502, 'ai_invalid_response', 'The AI sent back a plan we couldn\'t read. Please try again.', true);
  }

  const result = schema.safeParse(json);
  if (!result.success) throw invalidOutput(result.error.issues.slice(0, 5));
  return result.data;
}

function parseInput(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(i => i.path.join('.') || 'body'))].join(', ');
    throw new ApiError(400, 'invalid_input', `Some details look off (${fields}). Please check the form and try again.`, false);
  }
  return result.data;
}

// ─── ROUTES ───
app.post('/generate', generateLimiter, async (req, res) => {
  try {
    const p = parseInput(GenerateInput, req.body);

    const prompt = `You are an expert personal trainer. Create a ${p.days}-day workout split for:
- Age: ${p.age}, Gender: ${p.gender}, Weight: ${p.weight} ${p.unit}
- Goal: ${p.goal}, Experience: ${p.experience}, Equipment: ${p.equipment}

Fill in day_1 through day_${p.days} (one entry per training day). For each day give:
- focus: the muscle groups trained (e.g. "Chest & Triceps")
- type: a short label for the session (e.g. "Push", "Lower", "Full Body")
- duration_minutes: realistic total session length in minutes (between 20 and 120), including warm-up and the listed rest periods
- exercises: 5–7 exercises, each with name, muscle_group (the primary muscle group it targets), sets (formatted like "4 × 8–10"), rest (like "90s"), and a short coaching note

Also give a 2–3 sentence nutrition tip specific to their goal.
Only use exercises that are possible with their equipment. Make it specific, practical, and accurate for the person's stats and goal.`;

    const plan = await askForJson(prompt, planSchemaFor(p.days), 8000, raw => normalizePlan(raw, p.days));

    res.json({
      summary: [`${p.days} days/week`, cap(p.goal), cap(p.experience), p.equipment],
      days: plan.days,
      nutrition: plan.nutrition,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

app.post('/swap', swapLimiter, async (req, res) => {
  try {
    const p = parseInput(SwapInput, req.body);
    const ex = p.exercise;
    const avoid = [ex.name, ...p.avoid];

    const prompt = `You are an expert personal trainer. Suggest ONE replacement for an exercise in a workout.

Exercise to replace: ${ex.name}${ex.muscle_group ? ` (targets: ${ex.muscle_group})` : ''}
Current prescription: ${ex.sets}${ex.rest ? `, rest ${ex.rest}` : ''}
Workout day focus: ${p.dayFocus}
Person's goal: ${p.goal}, experience: ${p.experience}, equipment: ${p.equipment}

The replacement must target the same primary muscle group, be doable with "${p.equipment}", and suit a ${p.experience} lifter.
Do not suggest any of these (already in the workout): ${avoid.join('; ')}.
Give: name, muscle_group, sets (formatted like "4 × 8–10", similar volume to the original), rest (like "90s"), and a short coaching note.`;

    const taken = new Set(avoid.map(n => n.toLowerCase().trim()));
    const replacement = await askForJson(prompt, ExerciseSchema, 1000, raw => {
      const clean = normalizeExercise(raw);
      if (!clean) throw invalidOutput('swap is missing name or sets');
      if (taken.has(clean.name.toLowerCase())) throw invalidOutput(`swap repeated "${clean.name}"`);
      return clean;
    });

    res.json(replacement);
  } catch (err) {
    handleRouteError(res, err);
  }
});

function handleRouteError(res, err) {
  if (err instanceof ApiError) return sendError(res, err);
  console.error('Unexpected error:', err);
  sendError(res, new ApiError(500, 'server_error', 'Something went wrong on our side. Please try again.', true));
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
