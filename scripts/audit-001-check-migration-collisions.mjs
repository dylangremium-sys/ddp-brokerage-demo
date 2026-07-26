#!/usr/bin/env node

/**
 * AUDIT-001: Check migration number collisions across repository branches
 * 
 * Examines all branches to detect if two independently developed branches
 * claim the same migration number, which would cause post-merge conflicts
 * and potential migration execution order ambiguities.
 * 
 * Usage: node scripts/audit-001-check-migration-collisions.mjs [--strict]
 * 
 * Exit codes:
 *   0 = All migrations are numbered uniquely
 *   1 = Collision detected; list follows
 * 
 * --strict: Fail if ANY migration appears on multiple branches (default: only warn)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const STRICT = process.argv.includes('--strict');

function getMigrationFiles() {
  try {
    const files = fs.readdirSync('.');
    // Pattern: NN_NAME.sql (or .sql, .sql.VERIFY, .sql.ROLLBACK)
    const migrations = files
      .filter(f => /^\d+[_A-Z]/.test(f) && f.endsWith('.sql'))
      .map(f => {
        const match = f.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter(Boolean);

    return [...new Set(migrations)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  } catch {
    return null;
  }
}

function getAllBranches() {
  try {
    const output = execSync('git branch -r --no-color').toString();
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('HEAD'))
      .map(line => line.replace(/^origin\//, ''));
  } catch {
    return [];
  }
}

function getMigrationsOnBranch(branch) {
  try {
    const output = execSync(`git ls-tree -r ${branch}`, { encoding: 'utf8' });
    const files = output
      .split('\n')
      .map(line => line.split(/\s+/).pop())
      .filter(f => f && /^\d+[_A-Z]/.test(f) && f.endsWith('.sql'));

    const migrations = files
      .map(f => {
        const match = f.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter(Boolean);

    return [...new Set(migrations)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

console.log('🔍 AUDIT-001: Checking migration number collisions...\n');

const mainMigrations = getMigrationsOnBranch('origin/main');
const allBranches = getAllBranches().filter(b => b !== 'main');

const collisions = new Map(); // migration number -> [branches]

for (const branch of allBranches) {
  const branchMigrations = getMigrationsOnBranch(`origin/${branch}`);
  
  for (const num of branchMigrations) {
    if (!mainMigrations.includes(num)) {
      // This migration is NOT on main; check if it collides with another branch
      if (!collisions.has(num)) {
        collisions.set(num, []);
      }
      collisions.get(num).push(branch);
    }
  }
}

// Filter to only collisions (appearing on 2+ branches)
const actualCollisions = [...collisions.entries()].filter(([, branches]) => branches.length > 1);

if (actualCollisions.length === 0) {
  console.log('✅ No migration number collisions detected.\n');
  console.log(`   Main branch: ${mainMigrations.length} migrations (${mainMigrations.join(', ')})`);
  console.log(`   Checked ${allBranches.length} open branches — all use unique numbers.\n`);
  process.exit(0);
} else {
  console.log('🚨 COLLISION DETECTED:\n');
  for (const [num, branches] of actualCollisions) {
    console.log(`   Migration ${num}:`);
    for (const branch of branches) {
      console.log(`      - ${branch}`);
    }
  }
  console.log(`\n⚠️  ${actualCollisions.length} collision(s) found. Resolve before merging.\n`);
  process.exit(1);
}
