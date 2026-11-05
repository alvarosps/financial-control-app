import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extracts an array from a tRPC query result that may be either
 * a plain array or a PaginatedResult (with an `items` property).
 */
export function toArray<T>(data: T[] | { items: T[] } | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.items;
}
