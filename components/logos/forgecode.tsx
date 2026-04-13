import * as React from 'react'
import type { SVGProps } from 'react'

const ForgeCode = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 256"
    {...props}
  >
    <path
      fill="currentColor"
      d="M208 176H48l-16 48h192l-16-48Zm-160-8h160l8-24H40l8 24Zm-4-40h168l8-24H36l8 24ZM92 56h72v24H92V56Zm-8-8V48c0-13.255 10.745-24 24-24h40c13.255 0 24 10.745 24 24v24h16V48c0-22.091-17.909-40-40-40h-40c-22.091 0-40 17.909-40 40v24h16V48Z"
    />
  </svg>
)

export default ForgeCode
