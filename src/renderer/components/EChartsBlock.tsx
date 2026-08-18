/**
 * ECharts 图表独立组件
 * 动态 import echarts，避免阻塞首屏
 */

import type { EChartsOption, EChartsType } from 'echarts';
import { useEffect, useRef } from 'react';

export function EChartsBlock({
  optionJson,
  height = 320,
}: {
  optionJson: string;
  height?: number;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    let chart: EChartsType | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function bootstrap() {
      const echartsModule = await import('echarts');

      if (!mounted || !shellRef.current) {
        return;
      }

      chart = echartsModule.init(shellRef.current, undefined, {
        renderer: 'svg',
      });
      chart.setOption(JSON.parse(optionJson) as EChartsOption, true);

      resizeObserver = new ResizeObserver(() => {
        chart?.resize();
      });
      resizeObserver.observe(shellRef.current);
    }

    void bootstrap();

    return () => {
      mounted = false;
      resizeObserver?.disconnect();
      chart?.dispose();
    };
  }, [height, optionJson]);

  return (
    <div
      style={{
        width: '100%',
        height,
        margin: '0.5rem 0',
      }}
    >
      <div
        ref={shellRef}
        style={{
          width: '100%',
          height: '100%',
        }}
      />
    </div>
  );
}
