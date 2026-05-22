struct Attributes
{
    float4 positionOS : POSITION;
    float3 normalOS   : NORMAL;
    float2 uv         : TEXCOORD0;
};

struct Varyings { float4 positionCS : SV_Position; float2 uv : TEXCOORD0; };
