const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.post('/generate', async (req, res) => {
  const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();

  if (!API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY environment variable');
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY on server. Set it in .env or environment.' });
  }

  try {
    console.log('Sending request to Anthropic...');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2500,
        stream: false,
        messages: req.body.messages
      })
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }

    console.log('Anthropic response status:', response.status);
    console.log('Anthropic response body:', text);

    if (!response.ok) {
      const payload = typeof data === 'string' ? { error: data } : data;
      return res.status(response.status).json(payload);
    }

    if (typeof data === 'string') {
      res.type('text').send(data);
    } else {
      res.json(data);
    }

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log('Running on http://localhost:3000'));