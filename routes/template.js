const express = require("express");
const router = express.Router();
const path = require("path");
const fetch = require("node-fetch");


//this is a temporary endpoint to fix a specific pabbly cors issue
router.get('/proxy-pabbly', async (req, res) => {
    try {
        const pabblyUrl = 'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjUwNTZhMDYzNTA0MzU1MjY1NTUzNjUxMzUi_pc?'
            + new URLSearchParams(req.query).toString(); // Pass query params dynamically

        const response = await fetch(pabblyUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Check if response is JSON
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            res.json(data);
        } else {
            const text = await response.text();
            res.send(text);
        }

    } catch (error) {
        console.error("Error fetching Pabbly response:", error);
        res.status(500).json({ error: "Failed to fetch data from Pabbly", details: error.message });
    }
});

/*

router.all('/jubilee', async (req, res) => {
    try {
        const pabblyBaseUrl = 'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTY4MDYzZTA0MzM1MjZlNTUzMjUxMzIi_pc';
        const query = new URLSearchParams(req.query).toString();
        const pabblyUrl = `${pabblyBaseUrl}${query ? '?' + query : ''}`;

        const fetchOptions = {
            method: req.method,
            headers: { ...req.headers },
        };

        // Include the body for methods like POST/PUT/PATCH
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = JSON.stringify(req.body);
            fetchOptions.headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(pabblyUrl, fetchOptions);

        const contentType = response.headers.get("content-type");
        res.status(response.status);
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            res.json(data);
        } else {
            const text = await response.text();
            res.send(text);
        }

    } catch (error) {
        console.error("Error proxying to Pabbly:", error);
        res.status(500).json({ error: "Failed to proxy request to Pabbly", details: error.message });
    }
});*/




module.exports = router;