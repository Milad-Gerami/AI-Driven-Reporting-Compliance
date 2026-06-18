const app = require('./api/server');

// TODO: Read port from environment/configuration (e.g. process.env.PORT)
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`GovReport AI API listening on port ${PORT}`);
});
