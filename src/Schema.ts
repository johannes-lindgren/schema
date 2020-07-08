import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { Client, PrimitiveType, Context, SchemaDefinition, DefinitionType } from "./annotations";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";

import { ArraySchema, getArrayProxy } from "./types/ArraySchema";
import { MapSchema, getMapProxy } from "./types/MapSchema";
import { CollectionSchema } from './types/CollectionSchema';
import { SetSchema } from './types/SetSchema';

import { ChangeTree, Root, Ref, ChangeOperation } from "./changes/ChangeTree";
import { NonFunctionPropNames } from './types/HelperTypes';
import { EventEmitter } from './events/EventEmitter';

export interface DataChange<T=any> {
    op: OPERATION,
    field: number | string;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

export interface SchemaDecoderCallbacks {
    onAdd?: (item: any, key: any) => void;
    onRemove?: (item: any, key: any) => void;
    onChange?: (item: any, key: any) => void;
    clear();
    decode?(byte, it: decode.Iterator);
}

class EncodeSchemaError extends Error {}

function assertType(value: any, type: string, klass: Schema, field: string | number) {
    let typeofTarget: string;
    let allowNull: boolean = false;

    switch (type) {
        case "number":
        case "int8":
        case "uint8":
        case "int16":
        case "uint16":
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "float32":
        case "float64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
            return;
    }

    if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`)}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}

function assertInstanceType(
    value: Schema,
    type: typeof Schema
        | typeof ArraySchema
        | typeof MapSchema
        | typeof CollectionSchema
        | typeof SetSchema,
    klass: Schema,
    field: string | number,
) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${(value as any).constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}

function encodePrimitiveType(
    type: PrimitiveType,
    bytes: number[],
    value: any,
    klass: Schema,
    field: string | number,
) {
    assertType(value, type as string, klass, field);

    const encodeFunc = encode[type as string];

    if (encodeFunc) {
        encodeFunc(bytes, value);

    } else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    return decode[type as string](bytes, it);
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _typeid: number;
    static _context: Context;

    static _definition: SchemaDefinition = SchemaDefinition.create();

    static onError(e) {
        console.error(e);
    }

    static is(type: DefinitionType) {
        return (
            type['_definition'] &&
            type['_definition'].schema !== undefined
        );
    }

    protected $changes: ChangeTree;
    // protected $root: ChangeSet;

    protected $listeners: { [field: string]: EventEmitter<(a: any, b: any) => void> };

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: {
                value: new ChangeTree(this, undefined, new Root()),
                enumerable: false,
                writable: true
            },

            $listeners: {
                value: {},
                enumerable: false,
                writable: true
            },
        });

        const descriptors = this._descriptors;
        if (descriptors) {
            Object.defineProperties(this, descriptors);
        }

        //
        // Assign initial values
        //
        if (args[0]) {
            this.assign(args[0]);
        }
    }

    public assign(
        props: { [prop in NonFunctionPropNames<this>]: this[prop] }
    ) {
        //
        // TODO: recursivelly assign child Schema structures.
        //
        Object.assign(this, props);
        return this;
    }

    protected get _definition () { return (this.constructor as typeof Schema)._definition; }
    protected get _schema () { return this._definition.schema; }
    protected get _descriptors () { return this._definition.descriptors; }
    protected get _indexes () { return this._definition.indexes; }
    protected get _fieldsByIndex() { return this._definition.fieldsByIndex; }
    protected get _filters () { return this._definition.filters; }
    protected get _childFilters () { return this._definition.childFilters; }
    protected get _deprecated () { return this._definition.deprecated; }

    public listen <K extends NonFunctionPropNames<this>>(attr: K, callback: (value: this[K], previousValue: this[K]) => void) {
        if (!this.$listeners[attr as string]) {
            this.$listeners[attr as string] = new EventEmitter();
        }
        this.$listeners[attr as string].register(callback);

        // return un-register callback.
        return () =>
            this.$listeners[attr as string].remove(callback);
    }

    decode(
        bytes: number[],
        it: decode.Iterator = { offset: 0 },
        ref?: Ref,
        allChanges: Map<number, DataChange[]> = new Map<number, DataChange[]>(),
    ) {
        const $root = this.$changes.root;
        const totalBytes = bytes.length;

        let refId: number;
        let changes: DataChange[];

        while (it.offset < totalBytes) {
            let byte = bytes[it.offset++];

            if (byte === SWITCH_TO_STRUCTURE) {
                refId = decode.number(bytes, it);

                if (!$root.refs.has(refId)) {
                    $root.refs.set(refId, this);
                    ref = this;

                } else {
                    ref = $root.refs.get(refId) as Schema;
                }


                // create empty list of changes for this refId.
                changes = [];
                allChanges.set(refId, changes);

                // console.log("SWITCH_TO_STRUCTURE (DECODE)", {
                //     ref: ref.constructor.name,
                //     refId,
                // });

                continue;
            }

            const operation = byte;
            const fieldIndex = decode.number(bytes, it);

            const changeTree: ChangeTree = ref['$changes'];
            const isSchema = ref['_definition'];

            const field = (isSchema)
                ? (ref['_fieldsByIndex'] && ref['_fieldsByIndex'][fieldIndex])
                : fieldIndex;

            const _field = `_${field}`;

            let type = changeTree.getType(fieldIndex);
            let value: any;
            let previousValue: any;

            let dynamicIndex: number | string;

            if (operation === OPERATION.CLEAR) {
                (ref as SchemaDecoderCallbacks).clear();
                continue;
            }

            if (!isSchema) {
                previousValue = ref['getByIndex'](fieldIndex);

                if (
                    operation === OPERATION.ADD ||
                    operation === OPERATION.DELETE_AND_ADD
                ) {
                    dynamicIndex = (decode.stringCheck(bytes, it))
                        ? decode.string(bytes, it)
                        : decode.number(bytes, it);
                    ref['setIndex'](field, dynamicIndex);

                } else {
                    // here
                    dynamicIndex = ref['getIndex'](fieldIndex);
                }

            } else {
                previousValue = ref[_field];
            }

            // console.log("DECODE FIELD", {
            //     field,
            //     type,
            //     operation: OPERATION[operation],
            //     previousValue
            // });

            //
            // TODO: use bitwise operations to check for `DELETE` instead.
            //
            if (
                operation === OPERATION.DELETE ||
                operation === OPERATION.DELETE_AND_ADD
            )
            {
                if (operation !== OPERATION.DELETE_AND_ADD) {
                    ref['deleteByIndex'](fieldIndex);
                }

                value = null;
            }

            if (field === undefined) {
                console.warn("@colyseus/schema: definition mismatch");
                const nextIterator: decode.Iterator = { offset: it.offset };

                while (it.offset < totalBytes) {
                    //
                    // keep skipping next bytes until reaches a known structure
                    // by local decoder.
                    //
                    const nextByte = bytes[it.offset + 1];

                    if (nextByte === SWITCH_TO_STRUCTURE) {
                        nextIterator.offset = it.offset + 1;
                        if ($root.refs.has(decode.number(bytes, nextIterator))) {
                            break;
                        }
                    }

                    it.offset++;
                }

                continue;

            } else if (operation === OPERATION.DELETE) {
                //
                // FIXME: refactor me.
                // Don't do anything.
                //

            } else if (Schema.is(type)) {
                const refId = decode.number(bytes, it);
                value = $root.refs.get(refId);

                if (
                    operation !== OPERATION.REPLACE

                    // operation === OPERATION.ADD ||
                    // operation === OPERATION.DELETE_AND_ADD
                ) {
                    const childType = this.getSchemaType(bytes, it);

                    if (!value) {
                        value = this.createTypeInstance(bytes, it, childType || type as typeof Schema);
                        value.$changes.refId = refId;
                        $root.refs.set(refId, value);
                    }
                }

            } else if (ArraySchema.is(type)) {
                const valueRef: ArraySchema = (operation === OPERATION.REPLACE)
                    ? previousValue || new ArraySchema()
                    : new ArraySchema();
                value = valueRef.clone(true);

                const refId = decode.number(bytes, it);

                //
                // TODO: trigger onRemove if structure has been replaced.
                //
                // if (!$root.refs.has(refId) && value.length > 0) {
                //     value.forEach((element, i) => {
                //         changes.push({
                //             op: OPERATION.DELETE,
                //             field: i,
                //             // dynamicIndex,
                //             value: undefined,
                //             previousValue: element,
                //         });
                //     });
                // }

                // value.$changes.refId = refId;
                $root.refs.set(refId, value);

                value = getArrayProxy(value);

            } else if (MapSchema.is(type)) {
                const valueRef: MapSchema = (operation === OPERATION.REPLACE)
                    ? previousValue || new MapSchema()
                    : new MapSchema();
                value = valueRef.clone(true);

                const refId = decode.number(bytes, it);
                $root.refs.set(refId, value);

                value = getMapProxy(value);

            } else if (CollectionSchema.is(type)) {
                const valueRef: CollectionSchema = (operation === OPERATION.REPLACE)
                    ? previousValue || new CollectionSchema()
                    : new CollectionSchema();
                value = valueRef.clone(true);

                const refId = decode.number(bytes, it);
                $root.refs.set(refId, value);

            } else if (SetSchema.is(type)) {
                const valueRef: SetSchema = (operation === OPERATION.REPLACE)
                    ? previousValue || new SetSchema()
                    : new SetSchema();
                value = valueRef.clone(true);

                const refId = decode.number(bytes, it);
                $root.refs.set(refId, value);

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
            }

            // console.log("ADD TO CHANGES:", { refId });

            // if (
            //     // hasChange &&
            //     (
            //         this.onChange
            //         // || ref.$listeners[field]
            //     )
            // ) {
                changes.push({
                    op: operation,
                    field,
                    dynamicIndex,
                    value,
                    previousValue,
                });
            // }

            if (
                value !== null &&
                value !== undefined
            ) {
                if (value['$changes']) {
                    value['$changes'].setParent(
                        changeTree.ref,
                        changeTree.root,
                        fieldIndex,
                    );
                }

                if (ref instanceof Schema) {
                    ref[field] = value;

                    //
                    // FIXME: use `_field` instead of `field`.
                    //
                    // `field` is going to use the setter of the PropertyDescriptor
                    // and create a proxy for array/map. This is only useful for
                    // backwards-compatibility with @colyseus/schema@0.5.x
                    //
                    // // ref[_field] = value;

                } else if (ref instanceof MapSchema) {
                    const key = ref['$indexes'].get(field);
                    ref.set(key, value);

                } else if (ref instanceof ArraySchema) {
                    // const key = ref['$indexes'][field];
                    // console.log("SETTING FOR ArraySchema =>", { field, key, value });
                    // ref[key] = value;
                    ref.setAt(field, value);

                } else if (
                    ref instanceof CollectionSchema ||
                    ref instanceof SetSchema
                ) {
                    const index = ref.add(value);
                    ref['setIndex'](field, index);
                }
            }

        }

        this._triggerChanges(allChanges);

        return allChanges;
    }

    encode(
        root: Schema = this,
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        const refIdsVisited = new Set<number>();

        const changeTrees: ChangeTree[] = [this.$changes];
        let numChangeTrees = 1;

        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;
            const isSchema = (ref instanceof Schema);

            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();

            // mark this ChangeTree as visited.
            refIdsVisited.add(changeTree.refId);

            // console.log("SWITCH_TO_STRUCTURE (ENCODE)", {
            //     ref: ref.constructor.name,
            //     refId: changeTree.refId
            // });

            // root `refId` is skipped.
            encode.uint8(bytes, SWITCH_TO_STRUCTURE);
            encode.number(bytes, changeTree.refId);

            const changes: ChangeOperation[] | number[] = (encodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());

            // console.log("CHANGES =>", {
            //     changes,
            //     definition: ref['_definition'],
            //     isSchema: ref instanceof Schema,
            //     isMap: ref instanceof MapSchema,
            //     isArray: ref instanceof ArraySchema,
            // });

            for (let j = 0, cl = changes.length; j < cl; j++) {
                const operation: ChangeOperation = (encodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] as number }
                    : changes[j] as ChangeOperation;

                const fieldIndex = operation.index;

                const field = (isSchema)
                    ? ref['_fieldsByIndex'] && ref['_fieldsByIndex'][fieldIndex]
                    : fieldIndex;

                const _field = `_${field}`;

                // const type = changeTree.childType || ref._schema[field];
                const type = changeTree.getType(fieldIndex);

                // const type = changeTree.getType(fieldIndex);
                const value = changeTree.getValue(fieldIndex);

                // cache begin index if `useFilters`
                const beginIndex = bytes.length;

                // encode field index + operation
                if (operation.op > OPERATION.TOUCH) {
                    encode.uint8(bytes, operation.op);

                    // custom operations
                    if (operation.op === OPERATION.CLEAR) {
                        continue;
                    }

                    // indexed operations
                    encode.number(bytes, fieldIndex);
                }

                //
                // encode "alias" for dynamic fields (maps)
                //
                if (
                    !isSchema &&
                    //
                    // TODO: use bitwise operations to check for `DELETE` instead.
                    //
                    (
                        operation.op === OPERATION.ADD ||
                        operation.op === OPERATION.DELETE_AND_ADD
                    )
                ) {
                    if (ref instanceof MapSchema) {
                        //
                        // MapSchema dynamic key
                        //
                        const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                        encode.string(bytes, dynamicIndex);

                    } else if (
                        ref instanceof ArraySchema ||
                        ref instanceof CollectionSchema ||
                        ref instanceof SetSchema
                    ) {
                        //
                        // ArraySchema key
                        //
                        encode.number(bytes, fieldIndex);
                    }
                }

                // console.log("ENCODE FIELD", {
                //     ref: ref.constructor.name,
                //     type,
                //     field,
                //     value,
                //     op: OPERATION[operation.op]
                // })

                if (operation.op === OPERATION.DELETE) {
                    //
                    // TODO: delete from $root.cache
                    //
                    continue;
                }

                // Enqueue ChangeTree to be visited
                if (
                    value &&
                    value['$changes'] &&
                    !refIdsVisited.has(value['$changes'])
                ) {
                    changeTrees.push(value['$changes']);
                    value['$changes'].ensureRefId();
                    numChangeTrees++;
                }

                if (operation.op === OPERATION.TOUCH) {
                    continue;
                }

                if (Schema.is(type)) {
                    assertInstanceType(value, type as typeof Schema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                    // Try to encode inherited TYPE_ID if it's an ADD operation.
                    if (
                        operation.op === OPERATION.ADD ||
                        operation.op === OPERATION.DELETE_AND_ADD
                    ) {
                        this.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);
                    }

                } else if (ArraySchema.is(type)) {
                    //
                    // ensure a ArraySchema has been provided
                    //
                    assertInstanceType(ref[_field], ArraySchema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else if (MapSchema.is(type)) {
                    //
                    // ensure a MapSchema has been provided
                    //
                    assertInstanceType(ref[_field], MapSchema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else if (CollectionSchema.is(type)) {
                    //
                    // ensure a CollectionSchema has been provided
                    //
                    assertInstanceType(ref[_field], CollectionSchema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else if (SetSchema.is(type)) {
                    //
                    // ensure a SetSchema has been provided
                    //
                    assertInstanceType(ref[_field], SetSchema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else {
                    encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, field);

                    // const tempBytes = [];
                    // encodePrimitiveType(type as PrimitiveType, tempBytes, value, ref as Schema, field);

                    // console.log("ENCODE PRIMITIVE TYPE:", {
                    //     ref: ref.constructor.name,
                    //     field,
                    //     value,
                    //     bytes: tempBytes,
                    // })
                }

                if (useFilters) {
                    // cache begin / end index
                    changeTree.cache(fieldIndex as number, beginIndex, bytes.length)
                }
            }

            if (!encodeAll && !useFilters) {
                changeTree.discard();
            }
        }

        return bytes;
    }

    encodeAll (bytes?: number[]) {
        return this.encode(this, true, bytes);
    }

    applyFilters(encodedBytes: number[], client: Client, root = this) {
        let filteredBytes: number[] = [];

        const refIdsDissallowed = new Set<number>();
        const refIdsAllowed = new Set<number>([0]);

        // sort by refId, from lower to higher.
        const refIdsVisited = new Set<number>();

        const changeTrees = [this.$changes];
        let numChangeTrees = 1;

        // console.log("APPLY FILTERS, CHANGE TREES =>", changeTrees.map(c => ({
        //     ref: c.ref.constructor.name,
        //     refId: c.refId,
        //     changes: c.changes,
        //     parentIndex: c.parentIndex,
        // })));

        changetrees:
        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];

            if (refIdsDissallowed.has(changeTree.refId))  {
                // console.log("REFID IS NOT ALLOWED. SKIP.", { refId: changeTree.refId })
                continue;
            }

            const ref = changeTree.ref as Schema;
            const filters = ref._filters;

            // console.log("SWITCH_TO_STRUCTURE (APPLY FILTERS)", {
            //     ref: ref.constructor.name,
            //     refId: changeTree.refId
            // });

            encode.uint8(filteredBytes, SWITCH_TO_STRUCTURE);
            encode.number(filteredBytes, ref.$changes.refId);

            changeTree.changes.forEach((change, fieldIndex) => {
                // custom operations
                if (change.op === OPERATION.CLEAR) {
                    encode.uint8(filteredBytes, change.op);
                    return;
                }

                // indexed operation
                const cache = ref.$changes.caches[fieldIndex];
                const value = ref.$changes.getValue(fieldIndex);

                if (value['$changes']) {
                    changeTrees.push(value['$changes']);
                    numChangeTrees++;
                }

                if (
                    ref instanceof MapSchema ||
                    ref instanceof CollectionSchema ||
                    ref instanceof SetSchema ||
                    ref instanceof ArraySchema
                ) {
                    const parent = ref['$changes'].parent.ref as Schema;
                    const filter = changeTree.getChildrenFilter();

                    if (filter && !filter.call(parent, client, ref['$indexes'].get(fieldIndex), value, root)) {
                        if (value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);
                        }
                        return;
                    }

                } else {
                    const filter = (filters && filters[fieldIndex]);

                    if (filter && !filter.call(ref, client, value, root)) {
                        if (value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);;
                        }
                        return;
                    }
                }

                if (value['$changes']) {
                    refIdsAllowed.add(value['$changes'].refId);
                }

                //
                // Deleting fields: encode the operation + field index
                //
                if (change.op === OPERATION.DELETE) {
                    encode.uint8(filteredBytes, change.op);
                    encode.number(filteredBytes, fieldIndex);
                    return;

                } else if (change.op !== OPERATION.TOUCH) {
                    filteredBytes = filteredBytes.concat(encodedBytes.slice(cache.beginIndex, cache.endIndex));

                }
            });
        }

        return filteredBytes;
    }

    clone () {
        const cloned = new ((this as any).constructor);
        const schema = this._schema;
        for (let field in schema) {
            if (
                typeof (this[field]) === "object" &&
                typeof (this[field].clone) === "function"
            ) {
                // deep clone
                cloned[field] = this[field].clone();

            } else {
                // primitive values
                cloned[field] = this[field];
            }
        }
        return cloned;
    }

    triggerAll() {
        const changes: DataChange[] = [];
        const schema = this._schema;

        for (let field in schema) {
            if (this[field] !== undefined) {
                changes.push({
                    op: OPERATION.REPLACE,
                    field,
                    value: this[field],
                    previousValue: undefined
                });
            }
        }

        try {
            const allChanges = new Map<number, DataChange[]>();
            allChanges.set(this.$changes.refId, changes);
            this._triggerChanges(allChanges);

        } catch (e) {
            Schema.onError(e);
        }
    }

    toJSON () {
        const schema = this._schema;
        const deprecated = this._deprecated;

        const obj = {}
        for (let field in schema) {
            if (!deprecated[field] && this[field] !== null && typeof (this[field]) !== "undefined") {
                obj[field] = (typeof (this[field]['toJSON']) === "function")
                    ? this[field]['toJSON']()
                    : this[`_${field}`];
            }
        }
        return obj;
    }

    discardAllChanges() {
        this.$changes.discardAll();
    }

    protected getByIndex(index: number) {
        return this[this._fieldsByIndex[index]];
    }

    protected deleteByIndex(index: number) {
        delete this[this._fieldsByIndex[index]];
    }

    private tryEncodeTypeId (bytes: number[], type: typeof Schema, targetType: typeof Schema) {
        if (type._typeid !== targetType._typeid) {
            encode.uint8(bytes, TYPE_ID);
            encode.uint8(bytes, targetType._typeid);
        }
    }

    private getSchemaType(bytes: number[], it: decode.Iterator): typeof Schema {
        let type: typeof Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            type = (this.constructor as typeof Schema)._context.get(decode.uint8(bytes, it));
        }

        return type;
    }

    private createTypeInstance (bytes: number[], it: decode.Iterator, type: typeof Schema): Schema {
        let instance: Schema = new (type as any)();

        // assign root on $changes
        instance.$changes.root = this.$changes.root;

        return instance;
    }

    private _triggerChanges(allChanges: Map<number, DataChange[]>) {
        allChanges.forEach((changes, refId) => {
            if (changes.length > 0) {
                const ref = this.$changes.root.refs.get(refId);
                const isSchema = ref instanceof Schema;

                for (let i = 0; i < changes.length; i++) {
                    const change = changes[i];
                    const listener = ref['$listeners'] && ref['$listeners'][change.field];

                    if (!isSchema) {
                        if (
                            change.op === OPERATION.ADD &&
                            !change.previousValue
                        ) {
                            (ref as SchemaDecoderCallbacks).onAdd?.(change.value, change.dynamicIndex);

                        } else if (change.op === OPERATION.DELETE) {
                            (ref as SchemaDecoderCallbacks).onRemove?.(change.previousValue, change.dynamicIndex || change.field);

                        } else if (change.op === OPERATION.DELETE_AND_ADD) {
                            // TODO: refactor me!
                            (ref as SchemaDecoderCallbacks).onRemove?.(change.previousValue, change.dynamicIndex);
                            (ref as SchemaDecoderCallbacks).onAdd?.(change.value, change.dynamicIndex);

                        } else if (change.op === OPERATION.REPLACE) {
                            (ref as SchemaDecoderCallbacks).onChange?.(change.value, change.dynamicIndex);
                        }
                    }

                    //
                    // trigger onRemove on child structure.
                    //
                    if (
                        change.op === OPERATION.DELETE &&
                        change.previousValue instanceof Schema &&
                        change.previousValue.onRemove
                    ) {
                        change.previousValue.onRemove();
                    }

                    if (listener) {
                        try {
                            listener.invoke(change.value, change.previousValue);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }
                }

                if (isSchema) {
                    if (ref.onChange) {
                        try {
                            (ref as Schema).onChange(changes);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }
                }

            }

        });
    }
}
