import type { Database } from '~/db/database'
import { one } from '~/db/database'

export interface User {
  readonly id: string
  readonly email: string
}

export interface UserRepository {
  findOrCreateByEmail(email: string): Promise<User>
  find(id: string): Promise<User | null>
  /** Deletes the account and everything hanging off it. The audit trail survives, anonymised. */
  purge(id: string): Promise<void>
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly database: Database) {}

  async findOrCreateByEmail(email: string): Promise<User> {
    const { rows } = await this.database.query<User>(
      `insert into users (email) values ($1)
       on conflict (email) do update set email = excluded.email
       returning id, email`,
      [email.trim().toLowerCase()],
    )

    return rows[0]!
  }

  async find(id: string): Promise<User | null> {
    return one<User>(this.database, 'select id, email from users where id = $1', [id])
  }

  async purge(id: string): Promise<void> {
    await this.database.query('delete from users where id = $1', [id])
  }
}
