// Run assembleVideo in a FRESH process, so env-dependent config really applies.
//
// config.js snapshots process.env when it is first imported, and assemble.js imports it statically —
// so the usual `import('../../src/lib/x.js?bust')` trick cannot change STITCH_* or PYTHON_BIN for a
// module already loaded in this process. A child process is the only honest way to test what a user
// setting those in .env actually gets.
//
//   node test/helpers/assemble-child.mjs '{"clips":[...],"out":"...","opts":{...}}'
//
// Prints assembleVideo's result as JSON on stdout; logs stay on stderr.
const { clips, out, opts } = JSON.parse(process.argv[2]);
const { assembleVideo } = await import(new URL('../../src/lib/assemble.js', import.meta.url));
const res = await assembleVideo(clips, out, opts);
process.stdout.write(JSON.stringify(res));
