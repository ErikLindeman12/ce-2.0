import express, { Application } from 'express';
import orgRouter from './routes/orgs';

const app: Application = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'directory' });
});

app.use('/', orgRouter);

app.listen(PORT, () => {
  console.log(`[directory] listening on http://localhost:${PORT}`);
});
