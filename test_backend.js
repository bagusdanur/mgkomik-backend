const axios = require('axios');
async function test() {
  try {
    const res1 = await axios.get('http://localhost:3014/nekopoi/search?q=robin&page=1');
    console.log("Page 1 first item:", res1.data.data[0].title);
    const res2 = await axios.get('http://localhost:3014/nekopoi/search?q=robin&page=2');
    console.log("Page 2 first item:", res2.data.data[0].title);
  } catch (err) {
    console.log("Error:", err.message);
  }
}
test();
