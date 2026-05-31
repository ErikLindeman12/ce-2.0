import express, { Application } from 'express';
import tokenRoutes from './routes/tokens';

const app: Application = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3002;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'broker' });
});

app.use('/', tokenRoutes);

app.listen(PORT, () => {
  console.log(`broker listening on port ${PORT}`);
});

export default app;
