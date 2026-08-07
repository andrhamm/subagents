import { z } from "./zod-stub";

const CreateUser = z.object({ name: z.string() });
const UpdateUser = z.object({ name: z.string() });
const CreateOrder = z.object({ sku: z.string() });

export const routes = [
  { method: "GET", path: "/health", handler: () => ({ ok: true }) },
  { method: "POST", path: "/users", handler: (req: any) => CreateUser.parse(req.body) },
  { method: "PUT", path: "/users/:id", handler: (req: any) => UpdateUser.parse(req.body) },
  { method: "GET", path: "/users", handler: () => ({ users: [] }) },
  { method: "POST", path: "/orders", handler: (req: any) => CreateOrder.parse(req.body) },
  { method: "DELETE", path: "/orders/:id", handler: () => ({ deleted: true }) },
];
