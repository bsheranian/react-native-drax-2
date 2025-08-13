import React, {
	PropsWithChildren,
	useState,
	useRef,
	useEffect,
	useCallback,
	useMemo,
	useLayoutEffect,
	ForwardedRef,
	forwardRef,
	Ref,
} from "react";
import {
	ListRenderItemInfo,
	NativeScrollEvent,
	NativeSyntheticEvent,
	FlatList,
	Animated,
	StyleSheet,
} from "react-native";

import { DraxView } from "./DraxView";
import { DraxSubprovider } from "./DraxSubprovider";
import { useDraxId, useDraxContext } from "./hooks";
import {
	DraxListProps,
	DraxMonitorEventData,
	AutoScrollDirection,
	Position,
	DraxViewMeasurements,
	DraxMonitorDragDropEventData,
	DraxMonitorEndEventData,
	DraxViewRegistration,
	DraxSnapbackTargetPreset,
	isWithCancelledFlag,
	DraxEventDraggedViewData,
	DraxParentView,
} from "./types";
import { defaultListItemLongPressDelay } from "./params";

// FIXME: allow external drops past the last item

interface Shift {
	targetValue: number;
	animatedValue: Animated.Value;
}

interface ListItemPayload {
	index: number;
	originalIndex: number;
}

const defaultStyles = StyleSheet.create({
	draggingStyle: { opacity: 0 },
	dragReleasedStyle: { opacity: 0.5 },
});

const DraxListUnforwarded = <T extends unknown>(
	props: PropsWithChildren<DraxListProps<T>>,
	forwardedRef: ForwardedRef<FlatList>,
): JSX.Element => {
	const {
		data,
		style,
		flatListStyle,
		itemStyles,
		renderItemContent,
		renderItemHoverContent,
		onItemDragStart,
		onItemDragPositionChange,
		onItemDragEnd,
		onItemReorder,
		onReceiveExternalItem,
		viewPropsExtractor,
		id: idProp,
		allowReceivingExternalItems,
		reorderable: reorderableProp,
		onScroll: onScrollProp,
		itemsDraggable = true,
		lockItemDragsToMainAxis = false,
		longPressDelay = defaultListItemLongPressDelay,
		...flatListProps
	} = props;

	// Copy the value of the horizontal property for internal use.
	const horizontal = flatListProps.horizontal ?? false;

	// Get the item count for internal use.
	const itemCount = data?.length ?? 0;

	// Set a sensible default for reorderable prop.
	const reorderable = reorderableProp ?? onItemReorder !== undefined;

	// The unique identifer for this list's Drax view.
	const id = useDraxId(idProp);

	// FlatList, used for scrolling and measuring children
	const flatListRef = useRef<FlatList<T> | null>(null);

	// Container view measurements, for scrolling by percentage.
	const containerMeasurementsRef = useRef<DraxViewMeasurements | undefined>(
		undefined,
	);

	// Content size, for scrolling by percentage.
	const contentSizeRef = useRef<Position | undefined>(undefined);

	// Scroll position, for Drax bounds checking and auto-scrolling.
	const scrollPositionRef = useRef<Position>({ x: 0, y: 0 });

	// Original index of the currently dragged list item, if any.
	const draggedItemRef = useRef<number | undefined>(undefined);

	// Auto-scrolling state.
	const scrollStateRef = useRef(AutoScrollDirection.None);

	// Auto-scrolling interval.
	const scrollIntervalRef = useRef<NodeJS.Timeout | undefined>(undefined);

	// List item measurements, for determining shift.
	const itemMeasurementsRef = useRef<(DraxViewMeasurements | undefined)[]>(
		[],
	);

	// Drax view registrations, for remeasuring after reorder.
	const registrationsRef = useRef<(DraxViewRegistration | undefined)[]>([]);

	// Shift offsets.
	const shiftsRef = useRef<Shift[]>([]);

	// Maintain cache of reordered list indexes until data updates.
	const [originalIndexes, setOriginalIndexes] = useState<number[]>([]);

	// Maintain the index the item is currently dragged to.
	const draggedToIndex = useRef<number | undefined>(undefined);

	// Adjust measurements, registrations, and shift value arrays as item count changes.
	useEffect(() => {
		const itemMeasurements = itemMeasurementsRef.current;
		const registrations = registrationsRef.current;
		const shifts = shiftsRef.current;
		if (itemMeasurements.length > itemCount) {
			itemMeasurements.splice(itemCount - itemMeasurements.length);
		} else {
			while (itemMeasurements.length < itemCount) {
				itemMeasurements.push(undefined);
			}
		}
		if (registrations.length > itemCount) {
			registrations.splice(itemCount - registrations.length);
		} else {
			while (registrations.length < itemCount) {
				registrations.push(undefined);
			}
		}
		if (shifts.length > itemCount) {
			shifts.splice(itemCount - shifts.length);
		} else {
			while (shifts.length < itemCount) {
				shifts.push({
					targetValue: 0,
					animatedValue: new Animated.Value(0),
				});
			}
		}
	}, [itemCount]);

	// Clear reorders when data changes.
	useLayoutEffect(() => {
		// console.log('clear reorders');
		setOriginalIndexes(data ? [...Array(data.length).keys()] : []);
	}, [data]);

	// Apply the reorder cache to the data.
	const reorderedData = useMemo(() => {
		// console.log('refresh sorted data');
		if (!id || !data) {
			return null;
		}
		if (data.length !== originalIndexes.length) {
			return data;
		}
		return originalIndexes.map((index) => data[index]);
	}, [id, data, originalIndexes]);

	// Get shift transform for list item at index.
	const getShiftTransform = useCallback(
		(index: number) => {
			const shift = shiftsRef.current[index]?.animatedValue ?? 0;
			return horizontal
				? [{ translateX: shift }]
				: [{ translateY: shift }];
		},
		[horizontal],
	);

	// Set the currently dragged list item.
	const setDraggedItem = useCallback((originalIndex: number) => {
		draggedItemRef.current = originalIndex;
	}, []);

	// Clear the currently dragged list item.
	const resetDraggedItem = useCallback(() => {
		draggedItemRef.current = undefined;
	}, []);

	// Drax view renderItem wrapper.
	const renderItem = useCallback(
		(info: ListRenderItemInfo<T>) => {
			const { index, item } = info;
			const originalIndex = originalIndexes[index];
			const {
				style: itemStyle,
				draggingStyle = defaultStyles.draggingStyle,
				dragReleasedStyle = defaultStyles.dragReleasedStyle,
				...otherStyleProps
			} = itemStyles ?? {};
			return (
				<DraxView
					style={[
						itemStyle,
						{ transform: getShiftTransform(originalIndex) },
					]}
					draggingStyle={draggingStyle}
					dragReleasedStyle={dragReleasedStyle}
					{...otherStyleProps}
					longPressDelay={longPressDelay}
					lockDragXPosition={lockItemDragsToMainAxis && !horizontal}
					lockDragYPosition={lockItemDragsToMainAxis && horizontal}
					draggable={itemsDraggable}
					payload={{ index, originalIndex }}
					{...(viewPropsExtractor?.(item, index) ?? {})}
					onDragEnd={resetDraggedItem}
					onDragDrop={resetDraggedItem}
					onMeasure={(measurements) => {
						if (originalIndex !== undefined) {
							// console.log(`measuring [${index}, ${originalIndex}]: (${measurements?.x}, ${measurements?.y})`);
							itemMeasurementsRef.current[originalIndex] =
								measurements;
						}
					}}
					registration={(registration) => {
						if (registration && originalIndex !== undefined) {
							// console.log(`registering [${index}, ${originalIndex}], ${registration.id}`);
							registrationsRef.current[originalIndex] =
								registration;
							registration.measure();
						}
					}}
					renderContent={(contentProps) =>
						renderItemContent(info, contentProps)
					}
					renderHoverContent={
						renderItemHoverContent &&
						((hoverContentProps) =>
							renderItemHoverContent(info, hoverContentProps))
					}
				/>
			);
		},
		[
			originalIndexes,
			itemStyles,
			viewPropsExtractor,
			getShiftTransform,
			resetDraggedItem,
			itemsDraggable,
			renderItemContent,
			renderItemHoverContent,
			longPressDelay,
			lockItemDragsToMainAxis,
			horizontal,
		],
	);

	// Track the size of the container view.
	const onMeasureContainer = useCallback(
		(measurements: DraxViewMeasurements | undefined) => {
			containerMeasurementsRef.current = measurements;
		},
		[],
	);

	// Track the size of the content.
	const onContentSizeChange = useCallback((width: number, height: number) => {
		contentSizeRef.current = { x: width, y: height };
	}, []);

	// Set FlatList and node handle refs.
	const setFlatListRefs = useCallback(
		(ref) => {
			flatListRef.current = ref;
			if (forwardedRef) {
				if (typeof forwardedRef === "function") {
					forwardedRef(ref);
				} else {
					// eslint-disable-next-line no-param-reassign
					forwardedRef.current = ref;
				}
			}
		},
		[forwardedRef],
	);

	// Update tracked scroll position when list is scrolled.
	const onScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const {
				nativeEvent: { contentOffset },
			} = event;
			scrollPositionRef.current = { ...contentOffset };
			onScrollProp?.(event);
		},
		[onScrollProp],
	);

	// Handle auto-scrolling on interval.
	const doScroll = useCallback(() => {
		const flatList = flatListRef.current;
		const containerMeasurements = containerMeasurementsRef.current;
		const contentSize = contentSizeRef.current;
		if (!flatList || !containerMeasurements || !contentSize) {
			return;
		}
		let containerLength: number;
		let contentLength: number;
		let prevOffset: number;
		if (horizontal) {
			containerLength = containerMeasurements.width;
			contentLength = contentSize.x;
			prevOffset = scrollPositionRef.current.x;
		} else {
			containerLength = containerMeasurements.height;
			contentLength = contentSize.y;
			prevOffset = scrollPositionRef.current.y;
		}
		const jumpLength = containerLength * 0.2;
		let offset: number | undefined;
		if (scrollStateRef.current === AutoScrollDirection.Forward) {
			const maxOffset = contentLength - containerLength;
			if (prevOffset < maxOffset) {
				offset = Math.min(prevOffset + jumpLength, maxOffset);
			}
		} else if (scrollStateRef.current === AutoScrollDirection.Back) {
			if (prevOffset > 0) {
				offset = Math.max(prevOffset - jumpLength, 0);
			}
		}
		if (offset !== undefined) {
			flatList.scrollToOffset({ offset });
			flatList.flashScrollIndicators();
		}
	}, [horizontal]);

	// Start the auto-scrolling interval.
	const startScroll = useCallback(() => {
		if (scrollIntervalRef.current) {
			return;
		}
		doScroll();
		scrollIntervalRef.current = setInterval(doScroll, 250);
	}, [doScroll]);

	// Stop the auto-scrolling interval.
	const stopScroll = useCallback(() => {
		if (scrollIntervalRef.current) {
			clearInterval(scrollIntervalRef.current);
			scrollIntervalRef.current = undefined;
		}
	}, []);

	// If startScroll changes, refresh our interval.
	useEffect(() => {
		if (scrollIntervalRef.current) {
			stopScroll();
			startScroll();
		}
	}, [stopScroll, startScroll]);

	// Reset all shift values.
	const resetShifts = useCallback((animated: boolean = false) => {
		shiftsRef.current.forEach((shift) => {
			// eslint-disable-next-line no-param-reassign
			shift.targetValue = 0;
			if (animated) {
				Animated.timing(shift.animatedValue, {
					duration: 200,
					toValue: 0,
					useNativeDriver: true,
				}).start();
			} else {
				shift.animatedValue.setValue(0);
			}
		});
	}, []);

	const extractedStyles = StyleSheet.flatten(
		flatListProps.contentContainerStyle ?? {},
	);
	// @ts-ignore
	const gap = extractedStyles.gap ?? 0;
	// @ts-ignore
	const columnGap = extractedStyles.columnGap ?? gap;
	// @ts-ignore
	const rowGap = extractedStyles.rowGap ?? gap;

	// Update shift values in response to a drag.
	const updateShifts = useCallback(
		(fromPayload, toPayload, draggedMeasurements) => {
			const isExternalItem = fromPayload.parentId !== id;
			const fromIndex = isExternalItem ? -1 : fromPayload.index;
			const toIndex = toPayload.index;
			const { width = 50, height = 50 } = draggedMeasurements ?? {};
			const offset = horizontal ? width + columnGap : height + rowGap;

			// Early return if dragging to same position (internal items only)
			if (!isExternalItem && fromIndex === toIndex) {
				return;
			}

			originalIndexes.forEach((originalIndex, index) => {
				const shift = shiftsRef.current[originalIndex];
				let newTargetValue = 0;

				if (isExternalItem) {
					// External item: shift all items at and after the drop position forward
					if (index >= toIndex) {
						newTargetValue = offset;
					}
					// Items before the drop position remain at 0 (no shift needed)
				} else {
					// Internal item reordering
					if (fromIndex < toIndex) {
						// Moving forward: items between fromIndex+1 and toIndex shift backward
						if (index > fromIndex && index <= toIndex) {
							newTargetValue = -offset;
						}
						// The dragged item itself (at fromIndex) will move to toIndex position
						// All other items remain at 0
					} else if (fromIndex > toIndex) {
						// Moving backward: items between toIndex and fromIndex-1 shift forward
						if (index >= toIndex && index < fromIndex) {
							newTargetValue = offset;
						}
						// The dragged item itself (at fromIndex) will move to toIndex position
						// All other items remain at 0
					}
					// If fromIndex === toIndex, we already returned early above
				}

				// Only animate if the target value actually changed
				if (shift.targetValue !== newTargetValue) {
					shift.targetValue = newTargetValue;
					Animated.timing(shift.animatedValue, {
						duration: 200,
						toValue: newTargetValue,
						useNativeDriver: true,
					}).start();
				}
			});
		},
		[originalIndexes, horizontal, columnGap, rowGap, id],
	);

	// Calculate absolute position of list item for snapback.
	const calculateSnapbackTarget = useCallback(
		(fromPayload, toPayload) => {
			// If it's an external item, we don't need snapback
			if (fromPayload.parentId !== id) {
				return DraxSnapbackTargetPreset.None;
			}

			const { index: fromIndex, originalIndex: fromOriginalIndex } =
				fromPayload;

			const { index: toIndex } = toPayload;
			const containerMeasurements = containerMeasurementsRef.current;
			const itemMeasurements = itemMeasurementsRef.current;
			if (containerMeasurements) {
				let targetPos: Position | undefined;
				if (fromIndex < toIndex) {
					// Target pos(toIndex + 1) - pos(fromIndex)
					const nextIndex = toIndex + 1;
					let nextPos: Position | undefined;
					if (nextIndex < itemCount) {
						// toIndex + 1 is in the list. We can measure the position of the next item.
						const nextMeasurements =
							itemMeasurements[originalIndexes[nextIndex]];
						if (nextMeasurements) {
							nextPos = {
								x: nextMeasurements.x,
								y: nextMeasurements.y,
							};
						}
					} else {
						// toIndex is the last item of the list. We can use the list content size.
						const contentSize = contentSizeRef.current;
						if (contentSize) {
							nextPos = horizontal
								? { x: contentSize.x, y: 0 }
								: { x: 0, y: contentSize.y };
						}
					}
					const fromMeasurements =
						itemMeasurements[fromOriginalIndex];
					if (nextPos && fromMeasurements) {
						targetPos = horizontal
							? {
									x: nextPos.x - fromMeasurements.width,
									y: nextPos.y,
								}
							: {
									x: nextPos.x,
									y: nextPos.y - fromMeasurements.height,
								};
					}
				} else {
					// Target pos(toIndex)
					const toMeasurements = itemMeasurements[toIndex];
					if (toMeasurements) {
						targetPos = {
							x: toMeasurements.x,
							y: toMeasurements.y,
						};
					}
				}
				if (targetPos) {
					const scrollPosition = scrollPositionRef.current;
					return {
						x:
							containerMeasurements.x -
							scrollPosition.x +
							targetPos.x,
						y:
							containerMeasurements.y -
							scrollPosition.y +
							targetPos.y,
					};
				}
			}
			return DraxSnapbackTargetPreset.None;
		},
		[horizontal, itemCount, originalIndexes, id],
	);

	const handleDragEnd = useCallback(
		({ animateShifts }: { animateShifts: boolean }) => {
			// Reset all shifts regardless of what happens
			resetShifts(animateShifts);

			// Always stop auto-scroll on drag end.
			scrollStateRef.current = AutoScrollDirection.None;
			stopScroll();
		},
		[resetShifts, stopScroll],
	);

	// Stop auto-scrolling, and potentially update shifts and reorder data.
	const handleDragDrop = useCallback(
		(eventData: DraxMonitorDragDropEventData) => {
			handleDragEnd({ animateShifts: false });

			const { dragged } = eventData;

			const isOurDragged = dragged.parentId === id;
			const toIndex = findDropIndex(dragged);

			// Handle receiving external item
			if (
				allowReceivingExternalItems &&
				!isOurDragged &&
				reorderable &&
				toIndex !== undefined
			) {
				// If an external item was dropped on us, call the callback

				onReceiveExternalItem?.({
					dragged,
					toIndex,
				});

				// Reset currently dragged over position index to undefined

				if (draggedToIndex.current !== undefined) {
					draggedToIndex.current = undefined;
				}

				return DraxSnapbackTargetPreset.None;
			} else if (reorderable && isOurDragged) {
				// Determine list indexes of dragged/received items, if any.
				const fromPayload = dragged.payload;

				const { index: fromIndex, originalIndex: fromOriginalIndex } =
					fromPayload;

				const toItem =
					toIndex !== undefined ? data?.[toIndex] : undefined;

				onItemDragEnd?.({
					...eventData,
					toIndex,
					toItem,
					cancelled: isWithCancelledFlag(eventData)
						? eventData.cancelled
						: false,
					index: fromIndex,
					item: data?.[fromOriginalIndex],
				});

				// Reset currently dragged over position index to undefined
				if (draggedToIndex.current !== undefined) {
					onItemDragPositionChange?.({
						...eventData,
						index: fromIndex,
						item: data?.[fromOriginalIndex],
						toIndex: undefined,
						previousIndex: draggedToIndex.current,
					});

					draggedToIndex.current = undefined;
				}

				if (toIndex !== undefined) {
					// If dragged item and received item were ours, reorder data.
					const snapbackTarget = calculateSnapbackTarget(
						fromPayload,
						{ index: toIndex },
					);
					if (data) {
						const newOriginalIndexes = originalIndexes.slice();

						newOriginalIndexes.splice(
							toIndex,
							0,
							newOriginalIndexes.splice(fromIndex, 1)[0],
						);
						setOriginalIndexes(newOriginalIndexes);
						onItemReorder?.({
							fromIndex,
							fromItem: data[fromOriginalIndex],
							toIndex: toIndex,
							toItem: data[toIndex],
						});
					}
					return snapbackTarget;
				}
			}

			return undefined;
		},
		[
			id,
			data,
			handleDragEnd,
			reorderable,
			calculateSnapbackTarget,
			originalIndexes,
			onItemDragEnd,
			onItemDragPositionChange,
			onItemReorder,
			allowReceivingExternalItems,
			onReceiveExternalItem,
		],
	);

	// Monitor drag starts to handle callbacks.
	const onMonitorDragStart = useCallback(
		(eventData: DraxMonitorEventData) => {
			const { dragged } = eventData;
			// First, check if we need to do anything.
			if (reorderable && dragged.parentId === id) {
				// One of our list items is starting to be dragged.
				const { index, originalIndex }: ListItemPayload =
					dragged.payload;
				setDraggedItem(originalIndex);
				onItemDragStart?.({
					...eventData,
					index,
					item: data?.[originalIndex],
				});
			}
		},

		[id, reorderable, data, setDraggedItem, onItemDragStart],
	);

	const getRelativeScrollPosition = (
		position: Position,
		parent?: DraxParentView,
	): Position => {
		const parentScrollPosition = parent?.scrollPositionRef?.current;

		if (!parentScrollPosition) {
			return position;
		}

		const relativeParentScrollPosition = getRelativeScrollPosition(
			parentScrollPosition,
			parent.parent,
		);

		return {
			x: position.x + relativeParentScrollPosition.x,
			y: position.y + relativeParentScrollPosition.y,
		};
	};

	const findDropIndex = useCallback(
		(dragged: DraxEventDraggedViewData) => {
			// If no receiver but item is still over our list, calculate position
			if (data && data.length > 0) {
				// Get list item measurements (you'll need to store these)
				// @ts-ignore

				const relativeScrollPosition = getRelativeScrollPosition(
					scrollPositionRef.current,
					parent,
				);

				const itemCentroids = itemMeasurementsRef.current
					.map((measurements) => {
						// This assumes you have refs to your list items
						if (!measurements) return null;

						const centroid = horizontal
							? measurements.x + measurements.width / 2
							: measurements.y + measurements.height / 2;
						const scrollOffset = horizontal
							? relativeScrollPosition.x
							: relativeScrollPosition.y;
						return centroid - scrollOffset;
					})
					.filter((centroid): centroid is number => centroid !== null)
					.sort((a, b) => a - b);
				if (itemCentroids.length > 0) {
					// Calculate drag position with combined scroll offset
					const dragPosition = horizontal
						? dragged.absoluteMeasurements.x +
							dragged.dragOffset.x -
							dragged.grabOffset.x
						: dragged.absoluteMeasurements.y +
							dragged.dragOffset.y -
							dragged.grabOffset.y;

					// Check between items
					for (let i = 0; i < itemCentroids.length; i++) {
						if (dragPosition < itemCentroids[i]) {
							return i;
						}
					}
					return data.length;
				}
			}
			return undefined;
		},
		[data, horizontal, itemMeasurementsRef],
	);

	// Monitor drags to react with item shifts and auto-scrolling.
	const onMonitorDragOver = useCallback(
		(eventData: DraxMonitorEventData) => {
			const { dragged, monitorOffsetRatio } = eventData;
			const isDraggedFromOurList = dragged.parentId === id;
			// First, check if we need to shift items.

			if (
				reorderable &&
				(isDraggedFromOurList || allowReceivingExternalItems)
			) {
				// One of our list items is being dragged OR an external item is over our list
				const fromPayload = dragged.payload;

				// Add parent ID to distinguish external items
				fromPayload.parentId = dragged.parentId;

				// Check and update currently dragged over position index
				let toIndex = findDropIndex(dragged);

				if (toIndex !== draggedToIndex.current) {
					if (isDraggedFromOurList) {
						onItemDragPositionChange?.({
							...eventData,
							toIndex,
							index: fromPayload.index,
							item: data?.[fromPayload.originalIndex],
							previousIndex: draggedToIndex.current,
						});
					}
					if (toIndex === undefined) {
						resetShifts(true);
					}
					draggedToIndex.current = toIndex;
				}

				// Update shift transforms for items in the list
				if (toIndex !== undefined) {
					updateShifts(
						fromPayload,
						{ index: toIndex },
						dragged.absoluteMeasurements,
					);
				}
			}

			// Next, see if we need to auto-scroll.
			const ratio = horizontal
				? monitorOffsetRatio.x
				: monitorOffsetRatio.y;
			if (ratio > 0.1 && ratio < 0.9) {
				scrollStateRef.current = AutoScrollDirection.None;
				stopScroll();
			} else {
				if (ratio >= 0.9) {
					scrollStateRef.current = AutoScrollDirection.Forward;
				} else if (ratio <= 0.1) {
					scrollStateRef.current = AutoScrollDirection.Back;
				}
				startScroll();
			}
		},
		[
			id,
			reorderable,
			data,
			updateShifts,
			horizontal,
			stopScroll,
			startScroll,
			onItemDragPositionChange,
		],
	);

	// Monitor drag exits to stop scrolling, update shifts, and update draggedToIndex.
	const onMonitorDragExit = useCallback(
		() => handleDragEnd({ animateShifts: true }),
		[handleDragEnd],
	);

	/*
	 * Monitor drag ends to stop scrolling, update shifts, and possibly reorder.
	 * This addresses the Android case where if we drag a list item and auto-scroll
	 * too far, the drag gets cancelled.
	 */
	const onMonitorDragEnd = useCallback(
		() => handleDragEnd({ animateShifts: false }),
		[handleDragEnd],
	);

	// Monitor drag drops to stop scrolling, update shifts, and possibly reorder.
	const onMonitorDragDrop = useCallback(
		(eventData: DraxMonitorDragDropEventData) => handleDragDrop(eventData),
		[handleDragDrop],
	);

	const { parent } = useDraxContext();

	return (
		<DraxView
			id={id}
			style={style}
			receptive={true}
			scrollPositionRef={scrollPositionRef}
			onMeasure={onMeasureContainer}
			onMonitorDragStart={onMonitorDragStart}
			onMonitorDragOver={onMonitorDragOver}
			onMonitorDragExit={onMonitorDragExit}
			onMonitorDragEnd={onMonitorDragEnd}
			onMonitorDragDrop={onMonitorDragDrop}
		>
			<DraxSubprovider
				parent={{
					id,
					viewRef: {
						//@ts-ignore
						current: flatListRef.current?.getNativeScrollRef(),
					},
					scrollPositionRef,
					parent,
				}}
			>
				<FlatList
					{...flatListProps}
					style={flatListStyle}
					ref={setFlatListRefs}
					renderItem={renderItem}
					onScroll={onScroll}
					onContentSizeChange={onContentSizeChange}
					data={reorderedData}
				/>
			</DraxSubprovider>
		</DraxView>
	);
};

/*
 * We are using a type assertion to work around the loss of our generic
 * typing when forwarding the ref. See option 1 in this article:
 * https://fettblog.eu/typescript-react-generic-forward-refs/
 */
type DraxListType = <T extends unknown>(
	props: PropsWithChildren<DraxListProps<T>> & { ref?: Ref<FlatList> },
) => JSX.Element;
export const DraxList = forwardRef(DraxListUnforwarded) as DraxListType;
