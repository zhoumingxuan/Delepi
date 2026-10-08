const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function install() {
  const old = require.extensions['.ts'];
  require.extensions['.ts'] = (module, file) => {
    if (!file.startsWith(path.join(root, 'src') + path.sep)) throw new Error('Fixture source outside repository');
    const text = fs.readFileSync(file, 'utf8');
    module._compile(ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, file);
  };
  return () => {if (old) require.extensions['.ts'] = old; else delete require.extensions['.ts'];};
}
module.exports = {install, root};
