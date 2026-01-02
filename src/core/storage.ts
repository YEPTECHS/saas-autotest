/**
 * Local Storage Manager
 * Saves test data (users, sessions, etc.) for reuse across test flows
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');

export interface TestUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organization: string;
  registeredAt: string;
  flowName: string;
  plan?: string;
  status: 'registered' | 'verified' | 'paid' | 'active';
}

export interface StorageData {
  users: TestUser[];
  lastUpdated: string;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Get storage file path
 */
function getStoragePath(): string {
  return resolve(DATA_DIR, 'test-users.json');
}

/**
 * Load storage data
 */
export function loadStorage(): StorageData {
  ensureDataDir();
  const filePath = getStoragePath();

  if (!existsSync(filePath)) {
    return {
      users: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      users: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}

/**
 * Save storage data
 */
export function saveStorage(data: StorageData): void {
  ensureDataDir();
  const filePath = getStoragePath();
  data.lastUpdated = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Add a new test user
 */
export function addTestUser(user: Omit<TestUser, 'registeredAt'>): TestUser {
  const storage = loadStorage();

  const newUser: TestUser = {
    ...user,
    registeredAt: new Date().toISOString(),
  };

  // Check if user already exists (by email)
  const existingIndex = storage.users.findIndex(u => u.email === user.email);
  if (existingIndex >= 0) {
    // Update existing user
    storage.users[existingIndex] = newUser;
  } else {
    // Add new user
    storage.users.push(newUser);
  }

  saveStorage(storage);
  console.log(`[Storage] Saved user: ${user.email}`);

  return newUser;
}

/**
 * Get all test users
 */
export function getAllTestUsers(): TestUser[] {
  return loadStorage().users;
}

/**
 * Get users by status
 */
export function getUsersByStatus(status: TestUser['status']): TestUser[] {
  return loadStorage().users.filter(u => u.status === status);
}

/**
 * Get the latest registered user
 */
export function getLatestUser(): TestUser | undefined {
  const users = loadStorage().users;
  if (users.length === 0) return undefined;
  return users[users.length - 1];
}

/**
 * Get a random user for testing
 */
export function getRandomUser(): TestUser | undefined {
  const users = loadStorage().users;
  if (users.length === 0) return undefined;
  return users[Math.floor(Math.random() * users.length)];
}

/**
 * Update user status
 */
export function updateUserStatus(email: string, status: TestUser['status']): void {
  const storage = loadStorage();
  const user = storage.users.find(u => u.email === email);
  if (user) {
    user.status = status;
    saveStorage(storage);
  }
}

/**
 * Clear all test users
 */
export function clearAllUsers(): void {
  saveStorage({
    users: [],
    lastUpdated: new Date().toISOString(),
  });
  console.log('[Storage] Cleared all test users');
}
