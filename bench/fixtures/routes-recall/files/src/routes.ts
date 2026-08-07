// Routes file for validation testing.
// This fixture validates the ability to identify schema validations.
import { z } from './zod-stub';

const UserSchema = z.object({ name: 'string' });
const OrderSchema = z.object({ product: 'string' });

export const routes = [
  { method: 'POST', path: '/users', handler: (req: any) => z.object({}).parse(req.body) },
  { method: 'PUT', path: '/users/:id', handler: (req: any) => z.object({}).parse(req.body) },
  { method: 'GET', path: '/users', handler: (req: any) => ({ users: [] }) },
  { method: 'POST', path: '/orders', handler: (req: any) => z.object({}).parse(req.body) },
  { method: 'GET', path: '/orders', handler: (req: any) => ({ orders: [] }) },
  { method: 'DELETE', path: '/orders/:id', handler: (req: any) => ({ deleted: true }) },
];
