// Transport-only process: no runtime, container scheduler, or agent database.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRegisteredProjection } from './channels/channel-registry.js';
import './channels/index.js';

const path = process.argv[2];
if (!path || path === '--help') {
  console.log('Usage: projection-host CONFIG.json');
  process.exit(path ? 0 : 1);
}
const config = JSON.parse(await readFile(path, 'utf8'));
const module = await import(pathToFileURL(config.module).href);
const surface = await createRegisteredProjection(config.channel);
const projection = await module.startProjection(config.bus, surface);
console.log(`Projection ${config.channel} ready for ${config.bus.agent}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void projection.close().then(() => process.exit(0));
});
