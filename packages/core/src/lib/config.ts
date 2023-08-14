import type { GraphQLSchema } from 'graphql';
import type {
  KeystoneContext,
  KeystoneConfig,
  __InternalKeystoneConfig
} from '../types';
import { idFieldType } from './id-field';

function applyIdFieldDefaults(config: __InternalKeystoneConfig): __InternalKeystoneConfig['lists'] {
  // some error checking
  for (const [listKey, list] of Object.entries(config.lists)) {
    if (list.fields.id) {
      throw new Error(
        `A field with the \`id\` path is defined in the fields object on the ${JSON.stringify(
          listKey
        )} list. This is not allowed, use the idField option instead.`
      );
    }

    if (list.isSingleton && list.db?.idField) {
      throw new Error(
        `A singleton list cannot specify an idField, but it is configured at db.idField on the ${listKey} list`
      );
    }
  }

  // inject ID fields
  const listsWithIds: KeystoneConfig['lists'] = {};

  for (const [listKey, list] of Object.entries(config.lists)) {
    if (list.isSingleton) {
      // Singletons can only use an Int, idFieldType function ignores the `kind` if isSingleton is true
      listsWithIds[listKey] = {
        ...list,
        fields: {
          id: idFieldType(
            {
              kind: 'autoincrement',
              type: 'Int',
            },
            true
          ),
          ...list.fields,
        },
      };

      continue;
    }

    listsWithIds[listKey] = {
      ...list,
      fields: {
        id: idFieldType(list.db?.idField ?? config.db.idField, false),
        ...list.fields,
      },
    };
  }

  return listsWithIds;
}

function defaultIsAccessAllowed({ session, sessionStrategy }: KeystoneContext) {
  if (!sessionStrategy) return true;
  return session !== undefined;
}

export function initConfig(config: KeystoneConfig): __InternalKeystoneConfig {
  if (!['postgresql', 'sqlite', 'mysql'].includes(config.db.provider)) {
    throw new TypeError(
      'Invalid db configuration. Please specify db.provider as either "sqlite", "postgresql" or "mysql"'
    );
  }

  // WARNING: Typescript should prevent this, but empty string is useful for Prisma errors
  config.db.url ??= 'postgres://';

  // TODO: use zod or something if want to follow this path
  return {
    ...config,

    db: {
      shadowDatabaseUrl: '', // TODO: is this ok

      idField: { kind: 'cuid' },
      prismaClientPath: '@prisma/client',
      extendPrismaSchema: (schema: string) => schema,

      ...config.db,
    },

    graphql: {
      playground: process.env.NODE_ENV !== 'production',
      ...config?.graphql,
    },

    ui: {
      isAccessAllowed: defaultIsAccessAllowed,
      publicPages: [],
      basePath: '',
      ...config?.ui,
    },

    server: {
      cors: false,
      maxFileSize: 200 * 1024 * 1024, // 200 MiB
      healthCheck: {}, // TODO: remove

      extendExpressApp: async () => {},
      extendHttpServer: async () => {},
      ...config?.server,
    },

    storage: {
      ...config?.storage
    },

    types: {
      path: 'node_modules/.keystone/types.ts', // TODO: fix duplication of getSystemPaths
      ...config?.types
    },

    onStartup: async () => {},
    extendGraphqlSchema: (s: GraphQLSchema) => s,
    telemetry: config?.telemetry ?? true,

    lists: applyIdFieldDefaults(config),
  };
}
