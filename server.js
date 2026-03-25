const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.post('/generate', async (req, res) => {
  const API_KEY = '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';

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        stream: false,
        messages: req.body.messages
      })
    });

    const data = await response.json();
    console.log('Anthropic response:', JSON.stringify(data));
    res.json(data);

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log('Running on http://localhost:3000'));