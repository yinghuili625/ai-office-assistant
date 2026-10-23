// Functional tests represent a user who has just reviewed the current
// destination. Security regression tests use the raw client to test stale consent.
export function currentModelConsent(client, body) {
  return body?.consent === true && body.configRevision === undefined
    ? { ...body, configRevision: client.settings().configRevision }
    : body;
}

export function approveCurrentModel(client) {
  for (const method of ['testConnection', 'analyzeTemplate', 'generate', 'transcribe', 'recognizeImage']) {
    const original = client[method].bind(client);
    client[method] = (body, ...args) => original(currentModelConsent(client, body), ...args);
  }
  return client;
}
