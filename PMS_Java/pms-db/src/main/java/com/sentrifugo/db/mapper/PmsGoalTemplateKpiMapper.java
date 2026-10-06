package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsGoalTemplateKpiDTO;
import com.sentrifugo.db.entity.PmsGoalTemplateKpiEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsGoalTemplateKpiMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "kra", ignore = true)
    @Mapping(target = "kpi", ignore = true)
    PmsGoalTemplateKpiEntity toEntity(PmsGoalTemplateKpiDTO dto);

    @Mapping(source = "template.id", target = "templateId")
    @Mapping(source = "kra.id", target = "kraId")
    @Mapping(source = "kpi.id", target = "kpiId")
    PmsGoalTemplateKpiDTO toDTO(PmsGoalTemplateKpiEntity entity);

    List<PmsGoalTemplateKpiEntity> toEntityList(List<PmsGoalTemplateKpiDTO> dtoList);

    List<PmsGoalTemplateKpiDTO> toDTOList(List<PmsGoalTemplateKpiEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "template", ignore = true)
    @Mapping(target = "kra", ignore = true)
    @Mapping(target = "kpi", ignore = true)
    void updateEntityFromDto(PmsGoalTemplateKpiDTO dto, @MappingTarget PmsGoalTemplateKpiEntity entity);
}
