package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsGoalTemplateDTO;
import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
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
public interface PmsGoalTemplateMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    PmsGoalTemplateEntity toEntity(PmsGoalTemplateDTO dto);

    PmsGoalTemplateDTO toDTO(PmsGoalTemplateEntity entity);

    List<PmsGoalTemplateEntity> toEntityList(List<PmsGoalTemplateDTO> dtoList);

    List<PmsGoalTemplateDTO> toDTOList(List<PmsGoalTemplateEntity> entityList);

    @Mapping(target = "id", ignore = true)
    void updateEntityFromDto(PmsGoalTemplateDTO dto, @MappingTarget PmsGoalTemplateEntity entity);
}
