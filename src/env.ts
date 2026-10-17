// Must be the first import of the entry point: React and Ink pick their development or production build when they load.
// The development build checks every element and keeps a task stack per component; the UI then burns a core while idle.
process.env.NODE_ENV ??= 'production'
