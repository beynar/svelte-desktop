// One process keeps this state across HTTP requests (and across page navigation).
const counter: HostService<{ initial: number }> = ({ initial }, port) => {
  let count = initial;
  port.onRequest((command) => {
    if (command === 'increment') return { count: ++count, pid: process.pid };
    throw new Error('unknown counter command');
  });
  port.on('message', async () => { await port.postMessage({ count, pid: process.pid }); });
};
export default counter;
