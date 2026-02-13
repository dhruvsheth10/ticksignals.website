const https = require('https');

const url = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d';

const req = https.get(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
}, (res) => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
        if (res.statusCode === 200) {
            const meta = JSON.parse(body).chart?.result?.[0]?.meta;
            console.log('Symbol:', meta?.symbol, 'Price:', meta?.regularMarketPrice);
        } else {
            console.log('Body:', body.substring(0, 200));
        }
    });
});

req.on('error', (e) => console.error('Error:', e.message));
