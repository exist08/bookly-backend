import bcrypt from 'bcryptjs';

const COST = 12;

export const hashPassword = (password: string) => bcrypt.hash(password, COST);
export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/**
 * Compared against when the email doesn't exist, so a failed sign-in takes the
 * same time whether or not the account exists (no account enumeration by timing).
 */
const DUMMY_HASH = bcrypt.hashSync('bookly-timing-equaliser', COST);
export const burnPasswordCheck = (password: string) => bcrypt.compare(password, DUMMY_HASH);
