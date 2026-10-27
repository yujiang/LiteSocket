const { execFileSync } = require('node:child_process');
const { rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, relative, sep } = require('node:path');
const esbuild = require('esbuild');
const { generateDtsBundle } = require('dts-bundle-generator');

const root = resolve(__dirname, '..');
process.chdir(root);
const target = process.argv[2];
if (!['full', 'client', undefined].includes(target)) throw new Error(`Unknown build target: ${target}`);

function clean(folder) {
    const directory = resolve(root, 'lib', folder);
    if (relative(resolve(root, 'lib'), directory) !== folder) throw new Error('Invalid build directory');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
}

function tsc(project) {
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', project], { stdio: 'inherit' });
}

async function main() {
    if (!target || target === 'full') {
        clean('full');
        tsc('tsconfig.lib.json');
        console.log('Built lib/full (Node.js + declarations)');
    }
    if (!target || target === 'client') {
        clean('client');
        tsc('tsconfig.browser.json');
        const common = {
            entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', target: 'es2021',
            tsconfig: 'tsconfig.browser.json', sourcemap: true, metafile: true,
        };
        for (const [format, filename] of [['esm', 'index.js'], ['iife', 'litesocket.global.js']]) {
            const result = await esbuild.build({
                ...common, format, outfile: `lib/client/${filename}`,
                ...(format === 'iife' ? { globalName: 'LiteSocket' } : {}),
            });
            const inputs = Object.keys(result.metafile.inputs).map(file => file.split(sep).join('/'));
            if (inputs.some(file => file.includes('node_modules/') || /\/net\/(?:LiteServer|IOServer|LiteRoom|SockWrap)/.test(file))) {
                throw new Error('Browser bundle contains a Node.js dependency or server module');
            }
        }
        const [declarations] = generateDtsBundle([{ filePath: 'src/client.ts', output: { umdModuleName: 'LiteSocket' } }], {
            preferredConfigPath: 'tsconfig.browser.json',
        });
        writeFileSync('lib/client/index.d.ts', declarations);
        writeFileSync('lib/client/package.json', JSON.stringify({ type: 'module', main: 'index.js', types: 'index.d.ts' }, null, 2) + '\n');
        console.log('Built lib/client (browser ESM, script global LiteSocket + declarations)');
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
