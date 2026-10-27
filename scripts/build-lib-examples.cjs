const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { buildSync } = require('esbuild');

process.chdir(resolve(__dirname, '..'));
execFileSync(process.execPath, ['scripts/build.cjs'], { stdio: 'inherit' });
for (const project of ['tsconfig.example.lib.json', 'tsconfig.example.browser.json']) {
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', project], { stdio: 'inherit' });
}
buildSync({
    entryPoints: ['example/lib/example_lib_brower.ts'],
    bundle: true,
    external: ['../../lib/client/index.js'],
    format: 'esm', platform: 'browser', target: 'es2021', sourcemap: true,
    outfile: '.example-build/example/lib/example_lib_brower.js',
});
console.log('Built Node.js and browser lib examples');
