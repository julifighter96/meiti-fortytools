const fs = require('fs');
const path = require('path');

function log(entry) {
  const line = JSON.stringify(entry);
  // Console log for Railway logs
  console.log(line);

  // Additionally write to a local log file
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.appendFileSync(path.join(logsDir, 'app.log'), line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // Avoid crashing on logging errors
  }
}

module.exports = { log };

