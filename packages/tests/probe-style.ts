import { TestGpuixRenderer } from '@gpuix/native';
const r = new TestGpuixRenderer(800, 600);
r.applyBatch(JSON.stringify([['createElement', 1, 'div'], ['setRoot', 1]]));
const vals: [string, unknown][] = [
	['display','flex'],['display','block'],['display','grid'],['display','none'],['display','inline-flex'],['display','contents'],
	['position','absolute'],['position','relative'],['position','fixed'],['position','sticky'],
	['overflow','hidden'],['overflow','auto'],['overflow','scroll'],['overflow','visible'],
	['flexDirection','row'],['flexDirection','column'],['flexDirection','row-reverse'],
	['flexWrap','wrap'],['flexGrow',1],['flexShrink',0],['flexBasis',0],
	['alignItems','center'],['alignItems','flex-start'],['alignItems','baseline'],['alignItems','stretch'],
	['justifyContent','space-between'],['justifyContent','center'],['justifyContent','flex-end'],['justifyContent','space-evenly'],
	['alignSelf','center'],['alignContent','flex-start'],
	['whiteSpace','nowrap'],['whiteSpace','normal'],['whiteSpace','pre-wrap'],
	['textOverflow','ellipsis'],['textAlign','center'],['textAlign','left'],['textAlign','right'],
	['gridTemplateColumns',4],['gridTemplateRows',2],
	['visibility','hidden'],['visibility','visible'],
	['cursor','pointer'],['cursor','default'],['pointerEvents','none'],['pointerEvents','auto'],
	['userSelect','none'],['userSelect','text'],
	['fontWeight',600],['fontWeight','600'],['fontWeight','bold'],
	['width','50%'],['width','auto'],['width','12.5'],['minWidth',0],['maxWidth','100%'],
	['backgroundColor','#27272a'],['color','oklch(0.9 0.01 260)'],['background','rgba(0,0,0,0.5)'],
	['lineClamp',2],['opacity',0.5],['unknownProp','anything'],['zIndex',10],
];
for (const [k, v] of vals) {
	try {
		r.applyBatch(JSON.stringify([['setStyle', 1, { [k]: v }]]));
		console.log(`OK   ${k}: ${JSON.stringify(v)}`);
	} catch (e) {
		console.log(`FAIL ${k}: ${JSON.stringify(v)} → ${String(e).slice(0, 90)}`);
	}
}
