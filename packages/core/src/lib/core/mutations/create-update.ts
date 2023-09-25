import type { KeystoneContext, BaseItem } from '../../../types';
import type { ResolvedDBField } from '../resolve-relationships';
import type { InitialisedList } from '../initialise-lists';
import {
  promiseAllRejectWithAllErrors,
  getDBFieldKeyForFieldOnMultiField,
  IdType,
  runWithPrisma,
  getWriteLimit,
  getPrismaNamespace,
} from '../utils';
import { InputFilter, resolveUniqueWhereInput, UniqueInputFilter } from '../where-inputs';
import {
  accessDeniedError,
  extensionError,
  relationshipError,
  resolverError,
} from '../graphql-errors';
import { cannotForItem, getOperationAccess, getAccessFilters } from '../access-control';
import { checkFilterOrderAccess } from '../filter-order-access';
import {
  RelationshipErrors,
  resolveRelateToManyForCreateInput,
  resolveRelateToManyForUpdateInput,
} from './nested-mutation-many-input-resolvers';
import {
  resolveRelateToOneForCreateInput,
  resolveRelateToOneForUpdateInput,
} from './nested-mutation-one-input-resolvers';
import { applyAccessControlForCreate, getAccessControlledItemForUpdate } from './access-control';
import { validateList, validateFields } from './validation';

async function createSingle(
  { data: rawData }: { data: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext
) {
  // throw an accessDeniedError if not allowed
  await applyAccessControlForCreate(list, context, rawData);

  const { afterOperation, data } = await resolveInputForCreateOrUpdate(
    list,
    context,
    rawData,
    undefined
  );

  const writeLimit = getWriteLimit(context);

  const item = await writeLimit(() =>
    runWithPrisma(context, list, model =>
      model.create({ data: list.isSingleton ? { ...data, id: 1 } : data })
    )
  );

  return { item, afterOperation };
}

export class NestedMutationState {
  #afterOperations: (() => void | Promise<void>)[] = [];
  #context: KeystoneContext;
  constructor(context: KeystoneContext) {
    this.#context = context;
  }
  async create(data: Record<string, any>, list: InitialisedList) {
    const context = this.#context;

    const operationAccess = await getOperationAccess(list, context, 'create');
    if (!operationAccess) throw accessDeniedError(cannotForItem('create', list));

    const { item, afterOperation } = await createSingle({ data }, list, context);

    this.#afterOperations.push(() => afterOperation(item));
    return { id: item.id as IdType };
  }

  async afterOperation() {
    await promiseAllRejectWithAllErrors(this.#afterOperations.map(async x => x()));
  }
}

export async function createOne(
  createInput: { data: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'create');
  if (!operationAccess) throw accessDeniedError(cannotForItem('create', list));

  const { item, afterOperation } = await createSingle(createInput, list, context);

  await afterOperation(item);

  return item;
}

export async function createMany(
  createInputs: { data: Record<string, any>[] },
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'create');

  return createInputs.data.map(async data => {
    // throw for each attempt
    if (!operationAccess) throw accessDeniedError(cannotForItem('create', list));

    const { item, afterOperation } = await createSingle({ data }, list, context);
    await afterOperation(item);
    return item;
  });
}

async function updateSingle(
  updateInput: { where: UniqueInputFilter; data: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext,
  accessFilters: boolean | InputFilter
) {
  const { where: uniqueInput, data: rawData } = updateInput;
  // Validate and resolve the input filter
  const uniqueWhere = await resolveUniqueWhereInput(uniqueInput, list, context);

  // Check filter access
  const fieldKey = Object.keys(uniqueWhere)[0];
  await checkFilterOrderAccess([{ fieldKey, list }], context, 'filter');

  // Filter and Item access control. Will throw an accessDeniedError if not allowed.
  const item = await getAccessControlledItemForUpdate(
    list,
    context,
    uniqueWhere,
    accessFilters,
    rawData
  );

  const { afterOperation, data } = await resolveInputForCreateOrUpdate(
    list,
    context,
    rawData,
    item
  );

  const writeLimit = getWriteLimit(context);

  const updatedItem = await writeLimit(() =>
    runWithPrisma(context, list, model => model.update({ where: { id: item.id }, data }))
  );

  await afterOperation(updatedItem);

  return updatedItem;
}

export async function updateOne(
  updateInput: { where: UniqueInputFilter; data: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'update');
  if (!operationAccess) throw accessDeniedError(cannotForItem('update', list));

  // Get list-level access control filters
  const accessFilters = await getAccessFilters(list, context, 'update');

  return updateSingle(updateInput, list, context, accessFilters);
}

export async function updateMany(
  { data }: { data: { where: UniqueInputFilter; data: Record<string, any> }[] },
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'update');

  // Get list-level access control filters
  const accessFilters = await getAccessFilters(list, context, 'update');

  return data.map(async updateInput => {
    // throw for each attempt
    if (!operationAccess) throw accessDeniedError(cannotForItem('update', list));

    return updateSingle(updateInput, list, context, accessFilters);
  });
}

async function getResolvedData(
  list: InitialisedList,
  hookArgs: {
    context: KeystoneContext;
    listKey: string;
    inputData: Record<string, any>;
    item: undefined | BaseItem;
  },
  nestedMutationState: NestedMutationState
) {
  const {
    context,
    listKey,
    inputData,
    item
  } = hookArgs;
  const operation = item === undefined ? 'create' as const : 'update' as const;

  let resolvedData = inputData;

  // apply non-relationship field type input resolvers
  const resolverErrors: { error: Error; tag: string }[] = [];
  resolvedData = Object.fromEntries(
    await Promise.all(
      Object.entries(list.fields).map(async ([fieldKey, field]) => {
        const inputResolver = field.input?.[operation]?.resolve;
        let input = resolvedData[fieldKey];
        if (inputResolver && field.dbField.kind !== 'relation') {
          try {
            input = await inputResolver(input, context, undefined);
          } catch (error: any) {
            resolverErrors.push({ error, tag: `${list.listKey}.${fieldKey}` });
          }
        }
        return [fieldKey, input] as const;
      })
    )
  );

  if (resolverErrors.length) throw resolverError(resolverErrors);

  // apply relationship field type input resolvers
  const relationshipErrors: { error: Error; tag: string }[] = [];
  resolvedData = Object.fromEntries(
    await Promise.all(
      Object.entries(list.fields).map(async ([fieldKey, field]) => {
        const inputResolver = field.input?.[operation]?.resolve;
        let input = resolvedData[fieldKey];
        if (inputResolver && field.dbField.kind === 'relation') {
          const tag = `${list.listKey}.${fieldKey}`;
          try {
            input = await inputResolver(
              input,
              context,
              // this third argument only applies to relationship fields
              (() => {
                if (input === undefined) {
                  // no-op: this is what we want
                  return () => undefined;
                }
                if (input === null) {
                  // no-op: should this be userinputerror?
                  return () => undefined;
                }
                const foreignList = list.lists[field.dbField.list];
                if (field.dbField.mode === 'many' && operation === 'create') {
                  return resolveRelateToManyForCreateInput(
                    nestedMutationState,
                    context,
                    foreignList,
                    tag
                  );
                }

                if (field.dbField.mode === 'many' && operation === 'update') {
                  return resolveRelateToManyForUpdateInput(
                    nestedMutationState,
                    context,
                    foreignList,
                    tag
                  );
                }

                if (field.dbField.mode === 'one' && operation === 'create') {
                  return resolveRelateToOneForCreateInput(
                    nestedMutationState,
                    context,
                    foreignList
                  );
                }

                if (field.dbField.mode === 'one' && operation === 'update') {
                  return resolveRelateToOneForUpdateInput(
                    nestedMutationState,
                    context,
                    foreignList
                  );
                }

                throw new Error('Unknown relationship field type input mode or operation');
              })()
            );
          } catch (error: any) {
            if (error instanceof RelationshipErrors) {
              relationshipErrors.push(...error.errors);
            } else {
              relationshipErrors.push({ error, tag });
            }
          }
        }
        return [fieldKey, input] as const;
      })
    )
  );

  if (relationshipErrors.length) throw relationshipError(relationshipErrors);

  // field hooks
  const fieldsErrors: { error: Error; tag: string }[] = [];
  resolvedData = Object.fromEntries(
    await Promise.all(
      Object.entries(list.fields).map(async ([fieldKey, field]) => {
        try {
          if (item === undefined) {
            return [
              fieldKey,
              await field.hooks.resolveInput.create({
                context,
                listKey,
                operation: 'create',
                inputData,
                item: undefined,
                resolvedData,
                fieldKey,
              }),
            ];
          }

          return [
            fieldKey,
            await field.hooks.resolveInput.update({
              context,
              listKey,
              operation: 'update',
              inputData,
              item,
              resolvedData,
              fieldKey,
            }),
          ];
        } catch (error: any) {
          fieldsErrors.push({
            error,
            tag: `${list.listKey}.${fieldKey}.hooks.resolveInput`,
          });
          return [fieldKey, undefined];
        }
      })
    )
  );

  if (fieldsErrors.length) throw extensionError('resolveInput', fieldsErrors);

  // list hooks
  try {
    if (item === undefined) {
      return await list.hooks.resolveInput.create({
        context,
        listKey,
        operation: 'create',
        inputData,
        item: undefined,
        resolvedData
      });
    }

    return await list.hooks.resolveInput.update({
      context,
      listKey,
      operation: 'update',
      inputData,
      item,
      resolvedData
    });
  } catch (error: any) {
    throw extensionError('resolveInput', [{ error, tag: `${list.listKey}.hooks.resolveInput` }]);
  }
}

async function resolveInputForCreateOrUpdate(
  list: InitialisedList,
  context: KeystoneContext,
  inputData: Record<string, any>,
  item: BaseItem | undefined
) {
  const nestedMutationState = new NestedMutationState(context);
  const { listKey } = list;
  const operation = item === undefined ? 'create' as const : 'update' as const;

  const hookArgs = {
    context,
    listKey,
    operation,
    item,
    inputData,
    resolvedData: null as null | Record<string, any>
  } as any;
  hookArgs.resolvedData = await getResolvedData(list, hookArgs, nestedMutationState);

  // validate field hooks
  await validateFields(list, hookArgs);

  // validate list hooks // TODO: why isn't this first
  await validateList(list, hookArgs);

  // beforeOperation list hook
  if (hookArgs.operation === 'create') {
    await list.hooks.beforeOperation.create(hookArgs);
  } else {
    await list.hooks.beforeOperation.update(hookArgs);
  }

  // beforeOperation field hooks
  for (const fieldKey in list.fields) {
    await list.fields[fieldKey].hooks.beforeOperation[operation]({ ...hookArgs, fieldKey });
  }

  // Return the full resolved input (ready for prisma level operation),
  // and the afterOperation hook to be applied
  return {
    data: transformForPrismaClient(list.fields, hookArgs.resolvedData, context),
    afterOperation: async (updatedItem: BaseItem) => {
      await nestedMutationState.afterOperation();

      if (hookArgs.operation === 'create') {
        await list.hooks.afterOperation.create(hookArgs);

        // afterOperation field hooks
        for (const fieldKey in list.fields) {
          await list.fields[fieldKey].hooks.afterOperation[operation]({ ...hookArgs, fieldKey });
        }
      } else {
        await list.hooks.afterOperation.update(hookArgs);

        // afterOperation field hooks
        for (const fieldKey in list.fields) {
          await list.fields[fieldKey].hooks.afterOperation[operation]({ ...hookArgs, fieldKey });
        }
      }
    },
  };
}

function transformInnerDBField(
  dbField: Exclude<ResolvedDBField, { kind: 'multi' }>,
  context: KeystoneContext,
  value: unknown
) {
  if (dbField.kind === 'scalar' && dbField.scalar === 'Json' && value === null) {
    const Prisma = getPrismaNamespace(context);
    return Prisma.DbNull;
  }
  return value;
}

function transformForPrismaClient(
  fields: Record<string, { dbField: ResolvedDBField }>,
  data: Record<string, any>,
  context: KeystoneContext
) {
  return Object.fromEntries(
    Object.entries(data).flatMap(([fieldKey, value]) => {
      const { dbField } = fields[fieldKey];
      if (dbField.kind === 'multi') {
        return Object.entries(value).map(([innerFieldKey, fieldValue]) => {
          return [
            getDBFieldKeyForFieldOnMultiField(fieldKey, innerFieldKey),
            transformInnerDBField(dbField.fields[innerFieldKey], context, fieldValue),
          ];
        });
      }

      return [[fieldKey, transformInnerDBField(dbField, context, value)]];
    })
  );
}
