import type { KeystoneContext } from '../../../types';
import { cannotForItem, getOperationAccess, getAccessFilters } from '../access-control';
import { checkFilterOrderAccess } from '../filter-order-access';
import { accessDeniedError } from '../graphql-errors';
import type { InitialisedList } from '../initialise-lists';
import { getWriteLimit, runWithPrisma } from '../utils';
import { InputFilter, resolveUniqueWhereInput, UniqueInputFilter } from '../where-inputs';
import { getAccessControlledItemForDelete } from './access-control';
import { validateList, validateFields } from './validation';

async function deleteSingle(
  uniqueInput: UniqueInputFilter,
  list: InitialisedList,
  context: KeystoneContext,
  accessFilters: boolean | InputFilter
) {
  // Validate and resolve the input filter
  const uniqueWhere = await resolveUniqueWhereInput(uniqueInput, list, context);

  // Check filter access
  const fieldKey = Object.keys(uniqueWhere)[0];
  await checkFilterOrderAccess([{ fieldKey, list }], context, 'filter');

  // Filter and Item access control. Will throw an accessDeniedError if not allowed.
  const item = await getAccessControlledItemForDelete(list, context, uniqueWhere, accessFilters);
  const hookArgs = {
    operation: 'delete' as const,
    listKey: list.listKey,
    context,
    item,
    resolvedData: undefined,
    inputData: undefined,
  };

  // validate field hooks
  await validateFields({ list, hookArgs, operation: 'delete' });

  // validate list hooks // TODO: why isn't this first
  await validateList({ list, hookArgs, operation: 'delete' });

  // beforeOperation list hook
  await list.hooks.beforeOperation.delete(hookArgs);

  // beforeOperation field hooks
  for (const fieldKey in list.fields) {
    await list.fields[fieldKey].hooks.beforeOperation?.({ ...hookArgs, fieldKey });
  }

  const writeLimit = getWriteLimit(context);

  const newItem = await writeLimit(() =>
    runWithPrisma(context, list, model => model.delete({ where: { id: item.id } }))
  );

  // afterOperation list hook
  await list.hooks.afterOperation.delete({
    ...hookArgs,
    item: undefined,
    originalItem: item,
  });

  // afterOperation field hooks
  for (const fieldKey in list.fields) {
    await list.fields[fieldKey].hooks.afterOperation?.({
      ...hookArgs,
      fieldKey,
      item: undefined,
      originalItem: item,
    });
  }

  return newItem;
}

export async function deleteMany(
  uniqueInputs: UniqueInputFilter[],
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'delete');

  // Check filter permission to pass into single operation
  const accessFilters = await getAccessFilters(list, context, 'delete');

  return uniqueInputs.map(async uniqueInput => {
    // throw for each item
    if (!operationAccess) throw accessDeniedError(cannotForItem('delete', list));

    return deleteSingle(uniqueInput, list, context, accessFilters);
  });
}

export async function deleteOne(
  uniqueInput: UniqueInputFilter,
  list: InitialisedList,
  context: KeystoneContext
) {
  const operationAccess = await getOperationAccess(list, context, 'delete');
  if (!operationAccess) throw accessDeniedError(cannotForItem('delete', list));

  // Check filter permission to pass into single operation
  const accessFilters = await getAccessFilters(list, context, 'delete');

  return deleteSingle(uniqueInput, list, context, accessFilters);
}
