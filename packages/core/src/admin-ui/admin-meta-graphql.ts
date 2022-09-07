import { JSONValue } from '../types';
import { gql } from './apollo';

export const staticAdminMetaQuery = gql`
  query StaticAdminMeta {
    keystone {
      __typename
      adminMeta {
        __typename
        lists {
          __typename
          key
          itemQueryName
          listQueryName
          initialSort {
            __typename
            field
            direction
          }
          path
          label
          singular
          plural
          description
          initialColumns
          pageSize
          labelField
          isSingleton
          fields {
            __typename
            path
            label
            description
            fieldMeta
            viewsIndex
            customViewsIndex
            search
            itemView {
              fieldMode
            }
          }
        }
      }
    }
  }
`;

// generated by https://graphql-code-generator.com with these options:
// generates:
//   types.ts:
//     plugins:
//       - typescript-operations:
//           namingConvention: keep
//       - typescript:
//           enumsAsTypes: true
//           nonOptionalTypename: true
//           namingConvention: keep
//           noExport: true
//           avoidOptionals: true
//           scalars:
//             JSON: JSONValue

type Maybe<T> = T | null;

export type StaticAdminMetaQuery = {
  keystone: {
    __typename: 'KeystoneMeta';
    adminMeta: {
      __typename: 'KeystoneAdminMeta';
      lists: Array<{
        __typename: 'KeystoneAdminUIListMeta';
        key: string;
        itemQueryName: string;
        listQueryName: string;
        path: string;
        label: string;
        singular: string;
        plural: string;
        description: Maybe<string>;
        initialColumns: Array<string>;
        pageSize: number;
        labelField: string;
        initialSort: Maybe<{
          __typename: 'KeystoneAdminUISort';
          field: string;
          direction: KeystoneAdminUISortDirection;
        }>;
        isSingleton: boolean;
        fields: Array<{
          __typename: 'KeystoneAdminUIFieldMeta';
          path: string;
          label: string;
          description: Maybe<string>;
          fieldMeta: Maybe<JSONValue>;
          viewsIndex: number;
          customViewsIndex: Maybe<number>;
          search: Maybe<QueryMode>;
          itemView: Maybe<{
            __typename: 'KeystoneAdminUIFieldMetaItemView';
            fieldMode: Maybe<KeystoneAdminUIFieldMetaItemViewFieldMode>;
          }>;
        }>;
      }>;
    };
  };
};

type QueryMode = 'default' | 'insensitive';

type KeystoneAdminUIFieldMetaItemViewFieldMode = 'edit' | 'read' | 'hidden';

type KeystoneAdminUISortDirection = 'ASC' | 'DESC';
