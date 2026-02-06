/**
 * K-Lend SDK Version Watcher
 * 
 * Checks for new versions of @kamino-finance/klend-sdk on:
 *   - npm registry (new published versions)
 *   - GitHub commits (source changes)
 * 
 * Alerts when updates are available and logs breaking change indicators.
 * 
 * Usage: npx ts-node src/sdk-watch.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const STATE_PATH = path.join(__dirname, '..', 'config', 'sdk-watch-state.json');
const ALERT_PATH = path.join(__dirname, '..', 'config', 'alerts.jsonl');
const PACKAGE_PATH = path.join(__dirname, '..', 'node_modules', '@kamino-finance', 'klend-sdk', 'package.json');

interface SdkWatchState {
  lastCheck: string;
  installedVersion: string;
  latestNpmVersion: string;
  latestGitCommit: string;
  latestGitDate: string;
  npmVersionHistory: { version: string; detectedAt: string }[];
  gitCommitHistory: { sha: string; date: string; message: string; detectedAt: string }[];
}

function loadState(): SdkWatchState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      lastCheck: '',
      installedVersion: '',
      latestNpmVersion: '',
      latestGitCommit: '',
      latestGitDate: '',
      npmVersionHistory: [],
      gitCommitHistory: [],
    };
  }
}

function saveState(state: SdkWatchState) {
  if (state.npmVersionHistory.length > 50) state.npmVersionHistory = state.npmVersionHistory.slice(-50);
  if (state.gitCommitHistory.length > 50) state.gitCommitHistory = state.gitCommitHistory.slice(-50);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emitAlert(type: string, message: string) {
  const alert = { timestamp: new Date().toISOString(), type, message };
  fs.appendFileSync(ALERT_PATH, JSON.stringify(alert) + '\n');
  console.log(`\n🚨 ALERT [${type}]: ${message}\n`);
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

async function checkNpm(state: SdkWatchState) {
  console.log('📦 Checking npm registry...');
  
  // Get installed version
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
    state.installedVersion = pkg.version;
    console.log(`   Installed: ${state.installedVersion}`);
  } catch {
    console.log('   ⚠️ Could not read installed version');
  }
  
  // Get latest npm version
  const latestVersion = exec('npm view @kamino-finance/klend-sdk version');
  if (!latestVersion) {
    console.log('   ⚠️ Could not fetch npm version');
    return;
  }
  
  console.log(`   Latest npm: ${latestVersion}`);
  
  // Get all recent versions
  const allVersions = exec('npm view @kamino-finance/klend-sdk versions --json');
  if (allVersions) {
    try {
      const versions = JSON.parse(allVersions) as string[];
      const recent = versions.slice(-5);
      console.log(`   Recent versions: ${recent.join(', ')}`);
    } catch { /* ignore */ }
  }
  
  // Check if new version
  if (state.latestNpmVersion && latestVersion !== state.latestNpmVersion) {
    const isMajor = latestVersion.split('.')[0] !== state.latestNpmVersion.split('.')[0];
    const isMinor = latestVersion.split('.')[1] !== state.latestNpmVersion.split('.')[1];
    
    const severity = isMajor ? '🔴 MAJOR' : isMinor ? '🟡 MINOR' : '🟢 PATCH';
    
    emitAlert('SDK_NPM_UPDATE',
      `${severity} update: @kamino-finance/klend-sdk ${state.latestNpmVersion} → ${latestVersion}. ` +
      `Installed: ${state.installedVersion}. ` +
      (isMajor ? 'BREAKING CHANGES LIKELY — review changelog before updating.' :
       isMinor ? 'New features — review changes before updating.' :
       'Bug fix — safe to update.')
    );
    
    state.npmVersionHistory.push({
      version: latestVersion,
      detectedAt: new Date().toISOString(),
    });
  }
  
  state.latestNpmVersion = latestVersion;
}

async function checkGitHub(state: SdkWatchState) {
  console.log('\n📂 Checking GitHub commits...');
  
  const commitsJson = exec('gh api repos/Kamino-Finance/klend-sdk/commits?per_page=5 --jq \'[.[] | {sha: .sha[0:8], date: .commit.author.date, message: .commit.message | split("\\n")[0]}]\'');
  if (!commitsJson) {
    console.log('   ⚠️ Could not fetch GitHub commits');
    return;
  }
  
  try {
    const commits = JSON.parse(commitsJson) as { sha: string; date: string; message: string }[];
    
    for (const c of commits.slice(0, 3)) {
      console.log(`   ${c.sha} | ${c.date.slice(0, 10)} | ${c.message.slice(0, 60)}`);
    }
    
    const latest = commits[0];
    if (!latest) return;
    
    // Check if new commit since last check
    if (state.latestGitCommit && latest.sha !== state.latestGitCommit) {
      // Count how many new commits
      const knownIdx = commits.findIndex(c => c.sha === state.latestGitCommit);
      const newCount = knownIdx === -1 ? commits.length : knownIdx;
      
      // Check for breaking change indicators in commit messages
      const newCommits = commits.slice(0, knownIdx === -1 ? commits.length : knownIdx);
      const breakingIndicators = newCommits.filter(c => 
        c.message.toLowerCase().includes('breaking') ||
        c.message.toLowerCase().includes('major') ||
        c.message.toLowerCase().includes('remove') ||
        c.message.toLowerCase().includes('deprecat') ||
        c.message.toLowerCase().includes('rename')
      );
      
      const hasBreaking = breakingIndicators.length > 0;
      
      emitAlert('SDK_GIT_UPDATE',
        `📂 ${newCount} new commit(s) on Kamino-Finance/klend-sdk since last check. ` +
        `Latest: ${latest.sha} (${latest.date.slice(0, 10)}) — "${latest.message.slice(0, 60)}". ` +
        (hasBreaking ? `⚠️ Possible breaking changes detected in: ${breakingIndicators.map(c => c.message.slice(0, 40)).join('; ')}` :
         'No breaking change indicators found.')
      );
      
      for (const c of newCommits) {
        state.gitCommitHistory.push({
          ...c,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    
    state.latestGitCommit = latest.sha;
    state.latestGitDate = latest.date;
  } catch (err: any) {
    console.log(`   ⚠️ Parse error: ${err.message?.slice(0, 60)}`);
  }
}

async function checkChangelog(state: SdkWatchState) {
  console.log('\n📋 Checking for changelog/release notes...');
  
  const releases = exec('gh api repos/Kamino-Finance/klend-sdk/releases?per_page=3 --jq \'[.[] | {tag: .tag_name, date: .published_at, body: .body[0:200]}]\' 2>/dev/null');
  if (releases && releases !== '[]') {
    try {
      const parsed = JSON.parse(releases);
      for (const r of parsed) {
        console.log(`   ${r.tag} (${r.date?.slice(0, 10)}): ${r.body?.slice(0, 80) || 'No notes'}...`);
      }
    } catch { /* ignore */ }
  } else {
    console.log('   No GitHub releases found (commits only)');
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  🔍 K-Lend SDK Version Watcher');
  console.log('═══════════════════════════════════════════════\n');
  
  const state = loadState();
  
  await checkNpm(state);
  await checkGitHub(state);
  await checkChangelog(state);
  
  state.lastCheck = new Date().toISOString();
  saveState(state);
  
  // Summary
  console.log('\n───────────────────────────────────────────────');
  console.log(`Installed:  ${state.installedVersion}`);
  console.log(`Latest npm: ${state.latestNpmVersion}`);
  console.log(`Latest git: ${state.latestGitCommit} (${state.latestGitDate?.slice(0, 10)})`);
  
  if (state.installedVersion !== state.latestNpmVersion) {
    console.log(`\n⚠️ UPDATE AVAILABLE: npm install @kamino-finance/klend-sdk@${state.latestNpmVersion}`);
  } else {
    console.log('\n✅ Up to date with npm');
  }
  console.log('───────────────────────────────────────────────');
}

main().catch(console.error);
