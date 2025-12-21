const bcrypt = require("bcryptjs");
(async ()=>{
  const pass = process.argv[2];
  if(!pass){ console.log("Usage: node hash.js YOUR_PASSWORD"); process.exit(1); }
  const hash = await bcrypt.hash(pass, 10);
  console.log(hash);
})();