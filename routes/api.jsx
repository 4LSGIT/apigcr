const express = require('express');
const router = express.Router();
const fetch = require("node-fetch");

const API_KEY = process.env.API_KEY;
const TARGET_URL = process.env.FORWARD_TARGET || 'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTY4MDYzZTA0MzM1MjZlNTUzMjUxMzIi_pc';

// Middleware to check API key
router.use('/api/:path(*)?', (req, res, next) => {
  let key =
    req.header('x-api-key') ||
    req.query.apikey ||
    (req.header('authorization') && req.header('authorization').startsWith('Bearer ')
      ? req.header('authorization').substring(7)
      : null);

  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Forbidden: Invalid API key' });
  }

  req.resolvedApiKey = key; // Save the valid key for use later if needed
  next();
});


router.all('/api/:path(*)?', async (req, res) => {
  try {
    // Get original query params
    const originalParams = new URLSearchParams(req.query);

    // Add method and apikey (if present in headers)
    originalParams.set('method', req.method);
/*
    const apiKey = req.header('x-api-key');
    if (apiKey) {
      originalParams.set('apikey', apiKey);
    }*/

    const targetUrl = `${TARGET_URL}${req.params.path ? '/' + req.params.path : ''}?${originalParams.toString()}`;

    console.log('➡️ Forwarding to:', targetUrl);
    console.log('📦 Body:', req.body);

    const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    };

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get('content-type');
    const body = contentType && contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    res.status(response.status).set('content-type', contentType).send(body);
  } catch (err) {
    console.error('❌ Error forwarding request:', err.stack);
    res.status(500).json({ error: 'Error forwarding request' });
  }
});



module.exports = router;
