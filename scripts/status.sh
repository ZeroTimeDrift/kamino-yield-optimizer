#!/bin/bash
cd "$(dirname "$0")/.."
npx ts-node src/main.ts status
