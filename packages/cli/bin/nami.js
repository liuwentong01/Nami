#!/usr/bin/env node

const { createCLI } = require('../dist');

createCLI().parse(process.argv);
