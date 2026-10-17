const path = require('node:path');
(async () => {
  const { packager } = await import('@electron/packager');
  const result = await packager({
    dir: path.join(__dirname, '..'),
    out: path.join(__dirname, '..', '..', 'Orbit-portable-v2'),
    name: 'Orbit', platform: 'win32', arch: 'x64', icon: path.join(__dirname, '..', 'renderer', 'orbit.ico'),
    overwrite: true, asar: true,
    ignore: [/^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/],
    win32metadata: { CompanyName: 'Orbit', FileDescription: 'Orbit Browser', ProductName: 'Orbit Browser' }
  });
  console.log(result.join('\n'));
})().catch(error => { console.error(error); process.exit(1); });
