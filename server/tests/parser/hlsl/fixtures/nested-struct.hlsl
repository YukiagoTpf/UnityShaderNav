struct Inner { float3 normal; };
struct Outer { Inner inner; float4 position; };

Outer Make() { Outer o; return o; }
