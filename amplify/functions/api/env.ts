// The environment this function cannot run without, checked once.
//
// Every one of these values is wired in amplify/backend.ts and is present in
// any deploy that got as far as creating the function. The failure this guards
// is the one that happens anyway: a variable renamed on one side and not the
// other, a hand-edited console setting, a local invoke that never sourced the
// outputs. `process.env.X as string` compiles and then hands `undefined` to
// the AWS SDK, which fails somewhere deep in a signing or validation path with
// a message about a parameter nobody set - one 500 per request, forever, with
// nothing in the log that names the variable.
//
// Throwing here happens at module load instead, so the failure lands in the
// init phase of the first cold start, says which variable is missing, and says
// it once rather than once per request. The function is broken either way; the
// difference is entirely in how long it takes somebody to find out why.

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set - the api function cannot start without it. `
      + 'It is wired in amplify/backend.ts; a deploy that skipped that step, '
      + 'or a local invoke without amplify_outputs.json, gets here.',
    );
  }
  return value;
}
