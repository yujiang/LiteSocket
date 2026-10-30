const { execFileSync } = require('node:child_process');
const { rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { resolve, relative, sep, extname } = require('node:path');
const esbuild = require('esbuild');

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
    execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', project], { stdio: 'inherit' });
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
            entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', target: 'es2022',
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
        tsc('tsconfig.browser.declarations.json');
        rewriteBrowserTypeImports(resolve(root, 'lib/client/types'));
        writeFileSync('lib/client/index.d.ts', "export as namespace LiteSocket;\nexport * from './types/client.js';\n");
        writeFileSync('lib/client/package.json', JSON.stringify({ type: 'module', main: 'index.js', types: 'index.d.ts' }, null, 2) + '\n');
        console.log('Built lib/client (browser ESM, script global LiteSocket + declarations)');
    }
}

function rewriteBrowserTypeImports(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            rewriteBrowserTypeImports(file);
        } else if (entry.isFile() && file.endsWith('.d.ts')) {
            const declarations = readFileSync(file, 'utf8').replace(
                /(from\s+['"])(ws|\.{1,2}\/[^'"]+)(['"])/g,
                (match, prefix, moduleName, suffix) => {
                    if (moduleName === 'ws') moduleName = '../browser/ws';
                    if (moduleName.startsWith('.') && !extname(moduleName)) moduleName += '.js';
                    return `${prefix}${moduleName}${suffix}`;
                },
            );
            writeFileSync(file, declarations);
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
