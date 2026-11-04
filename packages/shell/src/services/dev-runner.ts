import { runService } from './child.ts';
const file = process.argv[2];
if (!file) throw new Error('dev-runner: service file missing');
runService((await import(file)).default);
