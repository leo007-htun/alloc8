const db = require('better-sqlite3')('data.sqlite');
const bcrypt = require('bcryptjs');
const user = db.prepare("SELECT * FROM users WHERE username = 'loughborough'").get();
console.log('User found:', !!user);
if (user) {
  console.log('Hash matches loughborough:', bcrypt.compareSync('loughborough', user.password_hash));
  console.log('Hash matches admin:', bcrypt.compareSync('admin', user.password_hash));
}
