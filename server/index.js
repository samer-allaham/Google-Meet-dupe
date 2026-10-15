import { createMeetServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const { httpServer } = createMeetServer();

httpServer.listen(port, host, () => {
  console.log(`Meetup running at http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => httpServer.close(() => process.exit(0)));
}
