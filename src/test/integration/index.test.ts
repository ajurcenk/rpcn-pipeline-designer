// The integration suites, in the order they must run (ticket 2.12): mocha would otherwise load
// separate files in an order of its own, and the activation suite must come first (its NON_YAML
// test checks the extension is not active yet; the later suites expect it to be active).
import './suites/00-activation';
import './suites/10-schema';
import './suites/20-gap-completion';
import './suites/30-bloblang';
import './suites/40-snippets';
import './suites/50-lint';
import './suites/60-run';
import './suites/70-feedback';
import './suites/80-graph';
