const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  try {
    const targetUrl = 'https://nekopoi.care/search/robin';
    const proxyUrl = 'https://neko.ezcantik9.workers.dev/?url=' + encodeURIComponent(targetUrl);
    const res = await axios.get(proxyUrl, {validateStatus: () => true});
    const $ = cheerio.load(res.data);
    
    console.log("Nav links html:", $(".nav-links").html());
  } catch (err) {
    console.log("Error:", err.message);
  }
}
test();
