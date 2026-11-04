package com.yueya.common.convert;

import org.mapstruct.InjectionStrategy;
import org.mapstruct.MapperConfig;
import org.mapstruct.MappingConstants;
import org.mapstruct.NullValueCheckStrategy;
import org.mapstruct.ReportingPolicy;

/**
 * 所有 MapStruct 转换器的统一配置，使用方式：{@code @Mapper(config = CentralMapperConfig.class)}。
 * <ul>
 *     <li>生成 Spring Bean，构造器注入（可直接 {@code private final XxxConverter converter;}）</li>
 *     <li>目标字段未映射时编译报错，避免 DTO/VO 新增字段后漏赋值；需要忽略的字段显式 {@code @Mapping(target = "x", ignore = true)}</li>
 *     <li>源字段多余不报错（实体字段通常比 VO 多）</li>
 * </ul>
 * 命名约定：转换器统一叫 {@code XxxConverter}，放在各模块的 {@code convert} 包下，
 * 避免与 MyBatis 的 {@code XxxMapper} 混淆。
 */
@MapperConfig(
        componentModel = MappingConstants.ComponentModel.SPRING,
        injectionStrategy = InjectionStrategy.CONSTRUCTOR,
        unmappedTargetPolicy = ReportingPolicy.ERROR,
        unmappedSourcePolicy = ReportingPolicy.IGNORE,
        nullValueCheckStrategy = NullValueCheckStrategy.ALWAYS)
public interface CentralMapperConfig {
}
