const axios = require('axios');
async function test() {
  try {
    const res = await axios.get('https://neko.ezcantik9.workers.dev/?url=https://nekopoi.care/search/jav', {validateStatus: () => true});
    console.log("Status jav:", res.status);
    console.log("Data:", res.data.substring(0, 200));
  } catch (err) {
    console.log("Error:", err.message);
  }
}
test();
