import { buildRepertoireTree, repertoireEntries } from './repertoireTree'
self.onmessage = event => {
  try { self.postMessage({ value: event.data.task === 'entries' ? repertoireEntries(event.data.lines, event.data.catalog) : buildRepertoireTree(event.data.entries) }) }
  catch (error) { self.postMessage({ error: (error as Error).message }) }
}
