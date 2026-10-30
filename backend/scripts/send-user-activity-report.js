'use strict';

require('dotenv').config();
const {
  previousSingaporeDate,
  sendDailyReport,
  stopUserActivity,
} = require('../services/userActivity');

const requestedDate = process.argv[2] || previousSingaporeDate();
const force = process.argv.includes('--force');

sendDailyReport(requestedDate, { force })
  .then(result => {
    console.log(JSON.stringify(result));
    stopUserActivity();
  })
  .catch(error => {
    console.error(error.message);
    stopUserActivity();
    process.exitCode = 1;
  });
