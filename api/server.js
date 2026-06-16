const express = require('express');
const healthRoutes = require('./routes/health');

const app = express();

app.use(express.json());
app.use('/api/v1/health', healthRoutes);

module.exports = app;
